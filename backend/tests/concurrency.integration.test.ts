/**
 * Integration test — requires a real Postgres reachable via DATABASE_URL
 * (docker-compose provides this; see README "Running tests"). This test
 * intentionally does NOT mock the database: the entire point is to prove
 * the FOR UPDATE SKIP LOCKED claim query is safe under real concurrency,
 * which a mocked pg client could never demonstrate.
 */
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function claimBatchLikeWorker(workerId: string, batchSize = 5) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id FROM executions
       WHERE status = 'PENDING' AND scheduled_for <= now()
       ORDER BY scheduled_for
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize]
    );
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      await client.query(
        `UPDATE executions SET status = 'RUNNING', locked_by = $1, locked_at = now() WHERE id = ANY($2::uuid[])`,
        [workerId, ids]
      );
    }
    await client.query('COMMIT');
    return rows.map((r) => r.id as string);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

describe('concurrent execution claiming (real Postgres)', () => {
  let userId: string;
  let jobIds: string[] = [];

  beforeAll(async () => {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`concurrency-test-${Date.now()}@test.local`]
    );
    userId = u.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM jobs WHERE owner_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  });

  it('never lets two concurrent workers claim the same execution', async () => {
    // A worker pool drains a shared queue across MANY jobs (not one job
    // looping on itself — the single-inflight constraint intentionally
    // caps one job at one in-flight execution; that's tested separately
    // below). Seed 20 jobs, each with one PENDING execution, so this test
    // exercises the real cross-job race the worker pool faces in production.
    const N = 20;
    for (let i = 0; i < N; i++) {
      const j = await pool.query(
        `INSERT INTO jobs (owner_id, name, target_url) VALUES ($1, $2, 'https://example.com') RETURNING id`,
        [userId, `concurrency test job ${i}`]
      );
      jobIds.push(j.rows[0].id);
      await pool.query(
        `INSERT INTO executions (job_id, status, trigger_source, attempt_number, idempotency_key, scheduled_for)
         VALUES ($1, 'PENDING', 'MANUAL', 1, $2, now())`,
        [j.rows[0].id, `concurrency-test-${i}-${Date.now()}`]
      );
    }

    // Fire 8 "workers" at once, each trying to claim batches of 5, repeatedly,
    // until nothing PENDING is left. This is the actual race condition the
    // assignment describes: "two workers picked it up at the same time".
    const claimedByWorker: Record<string, string[]> = {};
    const workers = Array.from({ length: 8 }, (_, i) => `test-worker-${i}`);

    async function drain(workerId: string) {
      claimedByWorker[workerId] = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const ids = await claimBatchLikeWorker(workerId, 3);
        if (ids.length === 0) break;
        claimedByWorker[workerId].push(...ids);
      }
    }

    await Promise.all(workers.map((w) => drain(w)));

    const allClaimed = Object.values(claimedByWorker).flat();
    const uniqueClaimed = new Set(allClaimed);

    // Core assertion: every execution was claimed exactly once across ALL
    // workers combined — no duplicates, none missed.
    expect(allClaimed.length).toBe(uniqueClaimed.size);
    expect(allClaimed.length).toBe(N);

    // Sanity check directly against the DB: every seeded execution ended
    // RUNNING with exactly one locked_by, never contested.
    const { rows: finalRows } = await pool.query(
      `SELECT status, locked_by FROM executions WHERE job_id = ANY($1::uuid[])`,
      [jobIds]
    );
    expect(finalRows.every((r) => r.status === 'RUNNING' && r.locked_by)).toBe(true);
  }, 20000);

  it('DB constraint blocks a second in-flight execution on the SAME job (no-concurrent-runs default)', async () => {
    const j = await pool.query(
      `INSERT INTO jobs (owner_id, name, target_url) VALUES ($1, 'single-inflight test job', 'https://example.com') RETURNING id`,
      [userId]
    );
    const jobId = j.rows[0].id;
    jobIds.push(jobId);

    await pool.query(
      `INSERT INTO executions (job_id, status, trigger_source, attempt_number, idempotency_key, scheduled_for)
       VALUES ($1, 'PENDING', 'MANUAL', 1, 'first-run', now())`,
      [jobId]
    );

    // Simulates a user clicking "Run Now" again while one is already queued —
    // this must fail at the DB layer even if two API instances raced on it.
    await expect(
      pool.query(
        `INSERT INTO executions (job_id, status, trigger_source, attempt_number, idempotency_key, scheduled_for)
         VALUES ($1, 'PENDING', 'MANUAL', 1, 'second-run', now())`,
        [jobId]
      )
    ).rejects.toThrow(/uq_job_single_inflight/);
  });
});
