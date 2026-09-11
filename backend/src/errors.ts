import { Request, Response, NextFunction } from 'express';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ConflictError extends ApiError {
  constructor(message = 'Resource was modified concurrently. Refresh and try again.') {
    super(409, message);
  }
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  // Postgres unique_violation on our single-inflight-execution index
  if (err?.code === '23505') {
    if (err?.constraint === 'uq_job_single_inflight') {
      return res.status(409).json({
        error: 'This job already has an execution in progress. Wait for it to finish or enable concurrent runs.',
      });
    }
    if (err?.constraint === 'uq_job_idempotency') {
      return res.status(200).json({ deduped: true, message: 'Duplicate trigger ignored (idempotency key already used).' });
    }
    return res.status(409).json({ error: 'Duplicate resource.' });
  }
  console.error('[unhandled error]', err);
  return res.status(500).json({ error: 'Internal server error' });
}
