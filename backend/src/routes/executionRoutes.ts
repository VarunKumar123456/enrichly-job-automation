import { Router } from 'express';
import { pool } from '../db';
import { AuthedRequest, requireAuth } from '../auth';
import { ApiError } from '../errors';

const router = Router();
router.use(requireAuth);

// Execution history for a job, paginated + filterable by status.
router.get('/job/:jobId', async (req: AuthedRequest, res, next) => {
  try {
    const owns = await pool.query('SELECT 1 FROM jobs WHERE id = $1 AND owner_id = $2', [req.params.jobId, req.userId]);
    if (owns.rows.length === 0) throw new ApiError(404, 'Job not found');

    const { status, limit = '50', offset = '0' } = req.query as Record<string, string>;
    const conditions = ['job_id = $1'];
    const params: any[] = [req.params.jobId];
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    params.push(Math.min(parseInt(limit, 10) || 50, 200));
    params.push(parseInt(offset, 10) || 0);

    const { rows } = await pool.query(
      `SELECT * FROM executions WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.* FROM executions e JOIN jobs j ON j.id = e.job_id WHERE e.id = $1 AND j.owner_id = $2`,
      [req.params.id, req.userId]
    );
    if (rows.length === 0) throw new ApiError(404, 'Execution not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// Manually retry a FAILED execution, even if its automatic retries were exhausted.
router.post('/:id/retry', async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, j.allow_concurrent_runs FROM executions e JOIN jobs j ON j.id = e.job_id WHERE e.id = $1 AND j.owner_id = $2`,
      [req.params.id, req.userId]
    );
    if (rows.length === 0) throw new ApiError(404, 'Execution not found');
    const exec = rows[0];
    if (exec.status !== 'FAILED') throw new ApiError(400, 'Only FAILED executions can be retried');

    const inserted = await pool.query(
      `INSERT INTO executions (job_id, status, trigger_source, attempt_number, parent_execution_id, idempotency_key, scheduled_for, enforce_single_inflight)
       VALUES ($1, 'PENDING', 'RETRY', $2, $3, $4, now(), $5)
       ON CONFLICT (job_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [exec.job_id, exec.attempt_number + 1, exec.id, `manual-retry-${exec.id}-${Date.now()}`, !exec.allow_concurrent_runs]
    );
    if (inserted.rows.length === 0) {
      return res.status(409).json({ error: 'Job already has an execution in progress' });
    }
    res.status(201).json(inserted.rows[0]);
  } catch (err) { next(err); }
});

// Cancel a PENDING execution before a worker picks it up.
router.post('/:id/cancel', async (req: AuthedRequest, res, next) => {
  try {
    const { rows, rowCount } = await pool.query(
      `UPDATE executions e SET status = 'CANCELLED', finished_at = now(), version = version + 1
       FROM jobs j
       WHERE e.id = $1 AND e.job_id = j.id AND j.owner_id = $2 AND e.status = 'PENDING'
       RETURNING e.*`,
      [req.params.id, req.userId]
    );
    if (rowCount === 0) throw new ApiError(409, 'Only PENDING executions can be cancelled (this one may already be running or finished)');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
