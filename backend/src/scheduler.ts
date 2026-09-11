
import cronParser from 'cron-parser';
import { pool } from './db';

const POLL_INTERVAL_MS = parseInt(
  process.env.SCHEDULER_POLL_INTERVAL_MS || '5000',
  10
);

/**
 * Finds ACTIVE jobs whose next_run_at is due, inserts a PENDING execution
 * for each, and advances next_run_at using the cron expression.
 *
 * FOR UPDATE SKIP LOCKED prevents multiple scheduler instances from
 * processing the same job at the same time.
 *
 * Each job is protected by a SAVEPOINT so that one job failing to enqueue
 * (for example, because another execution is already in flight) does not
 * roll back scheduling for every other due job in the same tick.
 */
async function tick() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: dueJobs } = await client.query(
      `SELECT id, cron_expression, next_run_at, allow_concurrent_runs
       FROM jobs
       WHERE status = 'ACTIVE'
         AND cron_expression IS NOT NULL
         AND next_run_at <= now()
       FOR UPDATE SKIP LOCKED
       LIMIT 50`
    );

    for (const job of dueJobs) {
      await client.query('SAVEPOINT schedule_job');

      try {
        const scheduledFor = new Date(job.next_run_at);
        const idempotencyKey = `schedule-${job.id}-${scheduledFor.toISOString()}`;

        await client.query(
          `INSERT INTO executions
             (
               job_id,
               status,
               trigger_source,
               attempt_number,
               idempotency_key,
               scheduled_for,
               enforce_single_inflight
             )
           VALUES ($1, 'PENDING', 'SCHEDULE', 1, $2, $3, $4)
           ON CONFLICT (job_id, idempotency_key) DO NOTHING`,
          [
            job.id,
            idempotencyKey,
            job.next_run_at,
            !job.allow_concurrent_runs,
          ]
        );

        try {
          const interval = cronParser.parseExpression(
            job.cron_expression,
            {
              currentDate: scheduledFor,
            }
          );

          const next = interval.next().toDate();

          await client.query(
            `UPDATE jobs
             SET next_run_at = $1
             WHERE id = $2`,
            [next, job.id]
          );

          await client.query('RELEASE SAVEPOINT schedule_job');

          console.log(
            `[scheduler] scheduled job ${job.id} for ${scheduledFor.toISOString()}`
          );
        } catch (err) {
          console.error(
            `[scheduler] invalid cron for job ${job.id}: ${job.cron_expression}`,
            err
          );

          await client.query(
            `UPDATE jobs
             SET status = 'PAUSED'
             WHERE id = $1`,
            [job.id]
          );

          await client.query('RELEASE SAVEPOINT schedule_job');
        }
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT schedule_job');
        await client.query('RELEASE SAVEPOINT schedule_job');

        if (err?.code === '23505') {
          console.warn(
            `[scheduler] skipped due execution for job ${job.id}; another execution is already in flight`
          );

          try {
            const interval = cronParser.parseExpression(
              job.cron_expression,
              {
                currentDate: new Date(job.next_run_at),
              }
            );

            const next = interval.next().toDate();

            await client.query(
              `UPDATE jobs
               SET next_run_at = $1
               WHERE id = $2`,
              [next, job.id]
            );
          } catch (cronErr) {
            console.error(
              `[scheduler] could not advance schedule for job ${job.id}`,
              cronErr
            );
          }
        } else {
          console.error(
            `[scheduler] failed to schedule job ${job.id}`,
            err
          );
        }
      }
    }

    await client.query('COMMIT');

    if (dueJobs.length > 0) {
      console.log(
        `[scheduler] processed ${dueJobs.length} due job(s)`
      );
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors if the connection is already aborted.
    }

    console.error('[scheduler] tick error', err);
  } finally {
    client.release();
  }
}

export function startScheduler() {
  console.log(
    `[scheduler] starting, polling every ${POLL_INTERVAL_MS}ms`
  );

  setInterval(() => {
    tick().catch((err) =>
      console.error('[scheduler] unhandled tick error', err)
    );
  }, POLL_INTERVAL_MS);
}
