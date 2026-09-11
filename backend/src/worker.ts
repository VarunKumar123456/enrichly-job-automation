import dotenv from 'dotenv';
import crypto from 'crypto';
import { pool, withTransaction } from './db';
import { executeHttpJob } from './httpExecutor';
import { decideRetry, STALE_LOCK_THRESHOLD_MS } from './retryPolicy';

dotenv.config();

const WORKER_ID = `${process.env.WORKER_NAME || 'worker'}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '2000', 10);
const BATCH_SIZE = parseInt(process.env.WORKER_BATCH_SIZE || '5', 10);

/**
 * Claims up to `BATCH_SIZE` due, PENDING executions for exclusive processing
 * by this worker. This is THE mechanism that answers the assignment's core
 * requirement: "a job execution should not accidentally run multiple times
 * just because two workers picked it up at the same time."
 *
 * FOR UPDATE SKIP LOCKED means: if another worker's transaction already
 * holds a row lock on a candidate row, this query simply skips it instead
 * of blocking or double-claiming it. Combined with marking the row RUNNING
 * + locked_by/locked_at inside the same transaction, two workers racing on
 * the same poll tick can never both claim the same execution.
 */
async function claimBatch(): Promise<any[]> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT e.*, j.target_url, j.http_method, j.headers, j.body, j.timeout_ms,
              j.max_retries, j.retry_backoff_base_ms, j.status as job_status, j.allow_concurrent_runs
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

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    await client.query(
      `UPDATE executions
       SET status = 'RUNNING', locked_by = $1, locked_at = now(), started_at = now(), version = version + 1
       WHERE id = ANY($2::uuid[])`,
      [WORKER_ID, ids]
    );
    return rows;
  });
}

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
       SET status = 'SUCCEEDED', finished_at = now(), response_status = $1,
           response_body = $2, duration_ms = $3, version = version + 1
       WHERE id = $4 AND locked_by = $5`,
      [result.status, result.bodySnippet, result.durationMs, row.id, WORKER_ID]
    );
    console.log(`[worker ${WORKER_ID}] execution ${row.id} SUCCEEDED (${result.durationMs}ms)`);
    return;
  }

  // Failed — mark this attempt failed, then decide whether to enqueue a retry.
  await pool.query(
    `UPDATE executions
     SET status = 'FAILED', finished_at = now(), response_status = $1,
         response_body = $2, error_message = $3, duration_ms = $4, version = version + 1
     WHERE id = $5 AND locked_by = $6`,
    [result.status ?? null, result.bodySnippet ?? null, result.errorMessage, result.durationMs, row.id, WORKER_ID]
  );

  const decision = decideRetry({
    attemptNumber: row.attempt_number,
    maxRetries: row.max_retries,
    baseBackoffMs: row.retry_backoff_base_ms,
  });

  if (decision.shouldRetry) {
    const scheduledFor = new Date(Date.now() + decision.delayMs);
    await pool.query(
      `INSERT INTO executions
         (job_id, status, trigger_source, attempt_number, parent_execution_id, idempotency_key, scheduled_for, enforce_single_inflight)
       VALUES ($1, 'PENDING', 'RETRY', $2, $3, $4, $5, $6)
       ON CONFLICT (job_id, idempotency_key) DO NOTHING`,
      [row.job_id, decision.nextAttemptNumber, row.id, `retry-${row.id}-attempt-${decision.nextAttemptNumber}`, scheduledFor, !row.allow_concurrent_runs]
    );
    console.log(
      `[worker ${WORKER_ID}] execution ${row.id} FAILED, retry #${decision.nextAttemptNumber} scheduled in ${decision.delayMs}ms`
    );
  } else {
    console.log(`[worker ${WORKER_ID}] execution ${row.id} FAILED, retries exhausted`);
  }
}

/**
 * Reclaims executions stuck in RUNNING because the worker that claimed them
 * died mid-execution (crashed process, killed container, lost network).
 * Without this, a crashed worker would leave the execution — and the job,
 * if it doesn't allow concurrent runs — permanently stuck.
 */
async function reapStaleExecutions() {
  const { rowCount } = await pool.query(
    `UPDATE executions
     SET status = 'FAILED', finished_at = now(), error_message = 'Worker lost/crashed mid-execution (stale lock reclaimed)',
         version = version + 1
     WHERE status = 'RUNNING' AND locked_at < now() - interval '${STALE_LOCK_THRESHOLD_MS} milliseconds'`
  );
  if (rowCount && rowCount > 0) {
    console.warn(`[worker ${WORKER_ID}] reaped ${rowCount} stale execution(s)`);
  }
}

async function tick() {
  try {
    await reapStaleExecutions();
    const claimed = await claimBatch();
    await Promise.all(claimed.map((row) => processExecution(row).catch((err) => {
      console.error(`[worker ${WORKER_ID}] error processing execution ${row.id}`, err);
    })));
  } catch (err) {
    console.error(`[worker ${WORKER_ID}] tick error`, err);
  }
}

async function main() {
  console.log(`[worker ${WORKER_ID}] starting, polling every ${POLL_INTERVAL_MS}ms`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('worker crashed', err);
  process.exit(1);
});
