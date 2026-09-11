import crypto from 'crypto';
import dotenv from 'dotenv';
import { pool, withTransaction } from './db';
import { executeHttpJob } from './httpExecutor';
import { decideRetry, STALE_LOCK_THRESHOLD_MS } from './retryPolicy';

dotenv.config();

const WORKER_ID = `${process.env.WORKER_NAME || 'worker'}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

const POLL_INTERVAL_MS = parseInt(
  process.env.WORKER_POLL_INTERVAL_MS || '2000',
  10
);

const BATCH_SIZE = parseInt(
  process.env.WORKER_BATCH_SIZE || '5',
  10
);

let workerStarted = false;
let workerStopping = false;

/**
 * Claims up to BATCH_SIZE due, PENDING executions for exclusive processing.
 *
 * FOR UPDATE SKIP LOCKED ensures that multiple workers/processes racing
 * for the same execution cannot claim the same row.
 */
async function claimBatch(): Promise<any[]> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT e.*, 
              j.target_url,
              j.http_method,
              j.headers,
              j.body,
              j.timeout_ms,
              j.max_retries,
              j.retry_backoff_base_ms,
              j.status AS job_status,
              j.allow_concurrent_runs
       FROM executions e
       JOIN jobs j ON j.id = e.job_id
       WHERE e.status = 'PENDING'
         AND e.scheduled_for <= now()
         AND j.status = 'ACTIVE'
       ORDER BY e.scheduled_for
       LIMIT $1
       FOR UPDATE OF e SKIP LOCKED`,
      [BATCH_SIZE]
    );

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);

    await client.query(
      `UPDATE executions
       SET status = 'RUNNING',
           locked_by = $1,
           locked_at = now(),
           started_at = now(),
           version = executions.version + 1
       WHERE id = ANY($2::uuid[])`,
      [WORKER_ID, ids]
    );

    return rows;
  });
}

/**
 * Executes one claimed execution and records the result.
 *
 * Failed executions are passed through the retry policy. Retry creation
 * is idempotent because each retry has a deterministic idempotency key.
 */
async function processExecution(row: any) {
  const result = await executeHttpJob({
    targetUrl: row.target_url,
    method: row.http_method,
    headers: row.headers || {},
    body: row.body,
    timeoutMs: row.timeout_ms,
  });

  if (result.ok) {
    await pool.query(
      `UPDATE executions
       SET status = 'SUCCEEDED',
           finished_at = now(),
           response_status = $1,
           response_body = $2,
           duration_ms = $3,
           version = executions.version + 1
       WHERE id = $4
         AND locked_by = $5`,
      [
        result.status,
        result.bodySnippet,
        result.durationMs,
        row.id,
        WORKER_ID,
      ]
    );

    console.log(
      `[worker ${WORKER_ID}] execution ${row.id} SUCCEEDED (${result.durationMs}ms)`
    );

    return;
  }

  await pool.query(
    `UPDATE executions
     SET status = 'FAILED',
         finished_at = now(),
         response_status = $1,
         response_body = $2,
         error_message = $3,
         duration_ms = $4,
         version = executions.version + 1
     WHERE id = $5
       AND locked_by = $6`,
    [
      result.status ?? null,
      result.bodySnippet ?? null,
      result.errorMessage,
      result.durationMs,
      row.id,
      WORKER_ID,
    ]
  );

  const decision = decideRetry({
    attemptNumber: row.attempt_number,
    maxRetries: row.max_retries,
    baseBackoffMs: row.retry_backoff_base_ms,
  });

  if (decision.shouldRetry) {
    const scheduledFor = new Date(
      Date.now() + decision.delayMs
    );

    await pool.query(
      `INSERT INTO executions
         (
           job_id,
           status,
           trigger_source,
           attempt_number,
           parent_execution_id,
           idempotency_key,
           scheduled_for,
           enforce_single_inflight
         )
       VALUES ($1, 'PENDING', 'RETRY', $2, $3, $4, $5, $6)
       ON CONFLICT (job_id, idempotency_key) DO NOTHING`,
      [
        row.job_id,
        decision.nextAttemptNumber,
        row.id,
        `retry-${row.id}-attempt-${decision.nextAttemptNumber}`,
        scheduledFor,
        !row.allow_concurrent_runs,
      ]
    );

    console.log(
      `[worker ${WORKER_ID}] execution ${row.id} FAILED, retry #${decision.nextAttemptNumber} scheduled in ${decision.delayMs}ms`
    );
  } else {
    console.log(
      `[worker ${WORKER_ID}] execution ${row.id} FAILED, retries exhausted`
    );
  }
}

/**
 * Reclaims executions stuck in RUNNING because the worker that claimed them
 * died or crashed before completing them.
 *
 * Stale executions are marked FAILED and then passed through the same retry
 * policy as normal execution failures.
 *
 * The stale update intentionally avoids UPDATE ... FROM so that columns such
 * as "version" cannot become ambiguous between executions and jobs.
 */
async function reapStaleExecutions() {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE executions
       SET status = 'FAILED',
           finished_at = now(),
           error_message = 'Worker lost/crashed mid-execution (stale lock reclaimed)',
           version = executions.version + 1
       WHERE executions.status = 'RUNNING'
         AND executions.locked_at < now() - interval '${STALE_LOCK_THRESHOLD_MS} milliseconds'
       RETURNING *`
    );

    for (const row of rows) {
      const { rows: jobRows } = await client.query(
        `SELECT max_retries,
                retry_backoff_base_ms,
                allow_concurrent_runs
         FROM jobs
         WHERE id = $1`,
        [row.job_id]
      );

      const job = jobRows[0];

      if (!job) {
        console.warn(
          `[worker ${WORKER_ID}] reaped stale execution ${row.id}; job not found`
        );

        continue;
      }

      const decision = decideRetry({
        attemptNumber: row.attempt_number,
        maxRetries: job.max_retries,
        baseBackoffMs: job.retry_backoff_base_ms,
      });

      if (decision.shouldRetry) {
        const scheduledFor = new Date(
          Date.now() + decision.delayMs
        );

        await client.query(
          `INSERT INTO executions
             (
               job_id,
               status,
               trigger_source,
               attempt_number,
               parent_execution_id,
               idempotency_key,
               scheduled_for,
               enforce_single_inflight
             )
           VALUES ($1, 'PENDING', 'RETRY', $2, $3, $4, $5, $6)
           ON CONFLICT (job_id, idempotency_key) DO NOTHING`,
          [
            row.job_id,
            decision.nextAttemptNumber,
            row.id,
            `retry-${row.id}-attempt-${decision.nextAttemptNumber}`,
            scheduledFor,
            !job.allow_concurrent_runs,
          ]
        );

        console.warn(
          `[worker ${WORKER_ID}] reaped stale execution ${row.id}; retry #${decision.nextAttemptNumber} scheduled in ${decision.delayMs}ms`
        );
      } else {
        console.warn(
          `[worker ${WORKER_ID}] reaped stale execution ${row.id}; retries exhausted`
        );
      }
    }
  });
}

/**
 * Runs one worker cycle:
 *
 * 1. Recover stale executions.
 * 2. Claim pending executions.
 * 3. Process claimed executions concurrently.
 */
async function tick() {
  try {
    await reapStaleExecutions();

    const claimed = await claimBatch();

    await Promise.all(
      claimed.map((row) =>
        processExecution(row).catch((err) => {
          console.error(
            `[worker ${WORKER_ID}] error processing execution ${row.id}`,
            err
          );
        })
      )
    );
  } catch (err) {
    console.error(
      `[worker ${WORKER_ID}] tick error`,
      err
    );
  }
}

/**
 * Starts the worker polling loop inside the current Node.js process.
 *
 * Used by the Render API Web Service so the application can run:
 * - HTTP API
 * - Scheduler
 * - Execution worker
 *
 * in one free instance.
 */
export function startWorker() {
  if (workerStarted) {
    console.log(
      `[worker ${WORKER_ID}] already started`
    );

    return;
  }

  workerStarted = true;

  console.log(
    `[worker ${WORKER_ID}] starting, polling every ${POLL_INTERVAL_MS}ms`
  );

  const run = async () => {
    while (!workerStopping) {
      await tick();

      await new Promise((resolve) =>
        setTimeout(resolve, POLL_INTERVAL_MS)
      );
    }
  };

  run().catch((err) => {
    console.error(
      `[worker ${WORKER_ID}] worker crashed`,
      err
    );
  });
}

/**
 * Graceful shutdown when the API process receives SIGTERM/SIGINT.
 */
export function stopWorker() {
  workerStopping = true;

  console.log(
    `[worker ${WORKER_ID}] stopping`
  );
}

/**
 * Keep standalone worker behavior for local Docker usage.
 *
 * When worker.ts is executed directly, it starts as a dedicated worker.
 * When imported by index.ts, it does not automatically start.
 */
if (require.main === module) {
  startWorker();

  const shutdown = () => {
    stopWorker();

    setTimeout(() => {
      process.exit(0);
    }, 100);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}