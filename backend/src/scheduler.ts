import cronParser from 'cron-parser';
import { pool } from './db';

const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_INTERVAL_MS || '5000', 10);

/**
 * Finds ACTIVE jobs whose next_run_at is due, inserts a PENDING execution
 * for each, and advances next_run_at using the cron expression. Runs as
 * its own loop (started alongside the API process) so scheduling logic is
 * decoupled from both the HTTP layer and the worker pool.
 *
 * Uses the same idempotency-key uniqueness as manual triggers: the key is
 * derived from job id + the specific scheduled minute, so if the scheduler
 * somehow ticks twice for the same due time (e.g. after a restart), the
 * second insert is a harmless no-op instead of a duplicate run.
 */
async function tick() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: dueJobs } = await client.query(
      `SELECT id, cron_expression, next_run_at, allow_concurrent_runs FROM jobs
       WHERE status = 'ACTIVE' AND cron_expression IS NOT NULL AND next_run_at <= now()
       FOR UPDATE SKIP LOCKED
       LIMIT 50`
    );

    for (const job of dueJobs) {
      const idempotencyKey = `schedule-${job.id}-${new Date(job.next_run_at).toISOString()}`;
      await client.query(
        `INSERT INTO executions (job_id, status, trigger_source, attempt_number, idempotency_key, scheduled_for, enforce_single_inflight)
         VALUES ($1, 'PENDING', 'SCHEDULE', 1, $2, $3, $4)
         ON CONFLICT (job_id, idempotency_key) DO NOTHING`,
        [job.id, idempotencyKey, job.next_run_at, !job.allow_concurrent_runs]
      );

      try {
        const interval = cronParser.parseExpression(job.cron_expression, { currentDate: new Date() });
        const next = interval.next().toDate();
        await client.query('UPDATE jobs SET next_run_at = $1 WHERE id = $2', [next, job.id]);
      } catch (err) {
        console.error(`[scheduler] invalid cron for job ${job.id}: ${job.cron_expression}`, err);
        await client.query("UPDATE jobs SET status = 'PAUSED' WHERE id = $1", [job.id]);
      }
    }
    await client.query('COMMIT');
    if (dueJobs.length > 0) console.log(`[scheduler] enqueued ${dueJobs.length} execution(s)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[scheduler] tick error', err);
  } finally {
    client.release();
  }
}

export function startScheduler() {
  console.log(`[scheduler] starting, polling every ${POLL_INTERVAL_MS}ms`);
  setInterval(() => {
    tick().catch((err) => console.error('[scheduler] unhandled tick error', err));
  }, POLL_INTERVAL_MS);
}
