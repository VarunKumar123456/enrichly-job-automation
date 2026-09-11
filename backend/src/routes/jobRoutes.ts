import { Router, Response } from 'express';
import crypto from 'crypto';
import cronParser from 'cron-parser';
import { z } from 'zod';
import { pool } from '../db';
import { AuthedRequest, requireAuth } from '../auth';
import { ApiError, ConflictError } from '../errors';

const router = Router();
router.use(requireAuth);

const jobInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  targetUrl: z.string().url(),
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string()).default({}),
  body: z.unknown().optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(10000),
  cronExpression: z.string().nullable().optional(),
  maxRetries: z.number().int().min(0).max(10).default(3),
  retryBackoffBaseMs: z.number().int().min(100).max(60000).default(2000),
  allowConcurrentRuns: z.boolean().default(false),
});

function computeNextRun(cronExpression?: string | null): Date | null {
  if (!cronExpression) return null;
  const interval = cronParser.parseExpression(cronExpression, { currentDate: new Date() });
  return interval.next().toDate();
}

// List jobs — supports search + status filter (product "beyond minimum" item)
router.get('/', async (req: AuthedRequest, res: Response, next) => {
  try {
    const { q, status } = req.query as { q?: string; status?: string };
    const conditions = ['owner_id = $1'];
    const params: any[] = [req.userId];

    if (q) {
      params.push(`%${q}%`);
      conditions.push(`name ILIKE $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT j.*,
              (SELECT count(*) FROM executions e WHERE e.job_id = j.id) as total_executions,
              (SELECT count(*) FROM executions e WHERE e.job_id = j.id AND e.status = 'FAILED') as failed_executions,
              (SELECT status FROM executions e WHERE e.job_id = j.id ORDER BY e.created_at DESC LIMIT 1) as last_execution_status
       FROM jobs j WHERE ${conditions.join(' AND ')} ORDER BY j.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1 AND owner_id = $2', [req.params.id, req.userId]);
    if (rows.length === 0) throw new ApiError(404, 'Job not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const input = jobInputSchema.parse(req.body);
    const nextRun = computeNextRun(input.cronExpression);

    const { rows } = await pool.query(
      `INSERT INTO jobs
        (owner_id, name, description, target_url, http_method, headers, body, timeout_ms,
         cron_expression, next_run_at, max_retries, retry_backoff_base_ms, allow_concurrent_runs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        req.userId, input.name, input.description ?? null, input.targetUrl, input.httpMethod,
        JSON.stringify(input.headers), input.body ? JSON.stringify(input.body) : null, input.timeoutMs,
        input.cronExpression ?? null, nextRun, input.maxRetries, input.retryBackoffBaseMs, input.allowConcurrentRuns,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Update — requires the client's last-known `version`. If it doesn't match
// the current row, another request modified it first: reject with 409
// rather than silently overwriting ("two requests update the same job").
router.put('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const input = jobInputSchema.partial().extend({ version: z.number().int() }).parse(req.body);
    const nextRun = input.cronExpression !== undefined ? computeNextRun(input.cronExpression) : undefined;

    const current = await pool.query('SELECT * FROM jobs WHERE id = $1 AND owner_id = $2', [req.params.id, req.userId]);
    if (current.rows.length === 0) throw new ApiError(404, 'Job not found');
    const existing = current.rows[0];

    const merged = {
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      target_url: input.targetUrl ?? existing.target_url,
      http_method: input.httpMethod ?? existing.http_method,
      headers: input.headers ? JSON.stringify(input.headers) : existing.headers,
      body: input.body !== undefined ? JSON.stringify(input.body) : existing.body,
      timeout_ms: input.timeoutMs ?? existing.timeout_ms,
      cron_expression: input.cronExpression !== undefined ? input.cronExpression : existing.cron_expression,
      next_run_at: nextRun !== undefined ? nextRun : existing.next_run_at,
      max_retries: input.maxRetries ?? existing.max_retries,
      retry_backoff_base_ms: input.retryBackoffBaseMs ?? existing.retry_backoff_base_ms,
      allow_concurrent_runs: input.allowConcurrentRuns ?? existing.allow_concurrent_runs,
    };

    const { rows, rowCount } = await pool.query(
      `UPDATE jobs SET name=$1, description=$2, target_url=$3, http_method=$4, headers=$5, body=$6,
         timeout_ms=$7, cron_expression=$8, next_run_at=$9, max_retries=$10, retry_backoff_base_ms=$11,
         allow_concurrent_runs=$12, version = version + 1
       WHERE id = $13 AND owner_id = $14 AND version = $15
       RETURNING *`,
      [
        merged.name, merged.description, merged.target_url, merged.http_method, merged.headers, merged.body,
        merged.timeout_ms, merged.cron_expression, merged.next_run_at, merged.max_retries,
        merged.retry_backoff_base_ms, merged.allow_concurrent_runs,
        req.params.id, req.userId, input.version,
      ]
    );

    if (rowCount === 0) throw new ConflictError();
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/pause', async (req: AuthedRequest, res, next) => {
  try {
    const { rows, rowCount } = await pool.query(
      `UPDATE jobs SET status = 'PAUSED', version = version + 1 WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [req.params.id, req.userId]
    );
    if (rowCount === 0) throw new ApiError(404, 'Job not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.post('/:id/resume', async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = await pool.query('SELECT cron_expression FROM jobs WHERE id = $1 AND owner_id = $2', [req.params.id, req.userId]);
    if (rows.length === 0) throw new ApiError(404, 'Job not found');
    const nextRun = computeNextRun(rows[0].cron_expression);
    const result = await pool.query(
      `UPDATE jobs SET status = 'ACTIVE', next_run_at = $1, version = version + 1 WHERE id = $2 AND owner_id = $3 RETURNING *`,
      [nextRun, req.params.id, req.userId]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const { rowCount } = await pool.query(`UPDATE jobs SET status = 'ARCHIVED', version = version + 1 WHERE id = $1 AND owner_id = $2`, [req.params.id, req.userId]);
    if (rowCount === 0) throw new ApiError(404, 'Job not found');
    res.status(204).send();
  } catch (err) { next(err); }
});

// Manual trigger ("Run Now"). Idempotency-Key header lets a flaky client
// retry the HTTP request itself without causing a second execution.
router.post('/:id/run', async (req: AuthedRequest, res, next) => {
  try {
    const job = await pool.query('SELECT id, allow_concurrent_runs FROM jobs WHERE id = $1 AND owner_id = $2', [req.params.id, req.userId]);
    if (job.rows.length === 0) throw new ApiError(404, 'Job not found');

    const idempotencyKey = (req.header('Idempotency-Key') || `manual-${crypto.randomUUID()}`).slice(0, 200);
    const enforceSingleInflight = !job.rows[0].allow_concurrent_runs;

    const { rows } = await pool.query(
      `INSERT INTO executions (job_id, status, trigger_source, attempt_number, idempotency_key, scheduled_for, enforce_single_inflight)
       VALUES ($1, 'PENDING', 'MANUAL', 1, $2, now(), $3)
       ON CONFLICT (job_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [req.params.id, idempotencyKey, enforceSingleInflight]
    );

    if (rows.length === 0) {
      // Either the idempotency key was reused, or uq_job_single_inflight
      // fired (caught in errorHandler) — but ON CONFLICT already absorbed
      // the idempotency case here, so this means "already has one in flight".
      const inflight = await pool.query(
        `SELECT * FROM executions WHERE job_id = $1 AND status IN ('PENDING','RUNNING') ORDER BY created_at DESC LIMIT 1`,
        [req.params.id]
      );
      return res.status(200).json({ deduped: true, execution: inflight.rows[0] ?? null });
    }

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Job-level statistics for the dashboard
router.get('/:id/stats', async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE e.status = 'SUCCEEDED') as succeeded,
         count(*) FILTER (WHERE e.status = 'FAILED') as failed,
         count(*) FILTER (WHERE e.status = 'RUNNING') as running,
         count(*) FILTER (WHERE e.status = 'PENDING') as pending,
         avg(e.duration_ms) FILTER (WHERE e.status = 'SUCCEEDED') as avg_duration_ms
       FROM executions e JOIN jobs j ON j.id = e.job_id
       WHERE j.id = $1 AND j.owner_id = $2`,
      [req.params.id, req.userId]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
