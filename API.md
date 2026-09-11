# API Reference

Base URL: `http://localhost:4000` (local) or your deployed backend URL.

All routes except `/health` and `/api/auth/*` require:
```
Authorization: Bearer <token>
```

---

## Auth

### `POST /api/auth/register`
Body: `{ "email": string, "password": string (min 8 chars) }`
→ `201` `{ token, user: { id, email } }`
→ `409` if email already registered

### `POST /api/auth/login`
Body: `{ "email": string, "password": string }`
→ `200` `{ token, user: { id, email } }`
→ `401` on invalid credentials

---

## Jobs

### `GET /api/jobs?q=&status=`
List the caller's jobs. `q` filters by name (partial match), `status` is one of `ACTIVE`/`PAUSED`/`ARCHIVED`.
→ `200` array of jobs, each including `total_executions`, `failed_executions`, `last_execution_status`.

### `GET /api/jobs/:id`
→ `200` job, or `404`

### `POST /api/jobs`
Body:
```json
{
  "name": "string (required)",
  "description": "string (optional)",
  "targetUrl": "string, valid URL (required)",
  "httpMethod": "GET|POST|PUT|PATCH|DELETE (default GET)",
  "headers": { "key": "value" },
  "body": {},
  "timeoutMs": 10000,
  "cronExpression": "5-field cron string, or null for manual-only",
  "maxRetries": 3,
  "retryBackoffBaseMs": 2000,
  "allowConcurrentRuns": false
}
```
→ `201` created job

### `PUT /api/jobs/:id`
Same body as create, **plus required `version`** (the job's current version — used for optimistic locking).
→ `200` updated job
→ `409` if `version` doesn't match the current row (someone else edited it first — refetch and retry)

### `POST /api/jobs/:id/pause` / `POST /api/jobs/:id/resume`
→ `200` updated job

### `DELETE /api/jobs/:id`
Soft-deletes (sets status to `ARCHIVED`).
→ `204`

### `POST /api/jobs/:id/run`
Manually trigger a job. Optional header `Idempotency-Key: <any string>` — reusing the same key returns the original execution instead of creating a duplicate.
→ `201` new execution
→ `200` `{ deduped: true, execution }` if the same idempotency key was already used
→ `409` if the job already has an execution in progress (and doesn't allow concurrent runs)

### `GET /api/jobs/:id/stats`
→ `200` `{ succeeded, failed, running, pending, avg_duration_ms }`

---

## Executions

### `GET /api/executions/job/:jobId?status=&limit=&offset=`
Execution history for a job, newest first. `limit` max 200 (default 50).
→ `200` array of executions

### `GET /api/executions/:id`
→ `200` single execution, or `404`

### `POST /api/executions/:id/retry`
Manually retry a `FAILED` execution (works even after automatic retries are exhausted).
→ `201` new execution
→ `400` if the execution isn't `FAILED`
→ `409` if the job already has one in progress

### `POST /api/executions/:id/cancel`
Cancel an execution that hasn't started yet.
→ `200` cancelled execution
→ `409` if it's no longer `PENDING` (already running or finished)

---

## Errors

All errors return `{ "error": "human-readable message" }` with an appropriate status code (`400`, `401`, `404`, `409`, `500`). `409` specifically means "retry with fresh data" — either an optimistic-lock conflict or a job already in flight.
