-- Enrichly Job Automation Platform — initial schema
-- Design notes are in ENGINEERING.md. Key ideas encoded here:
--  1. executions.version + optimistic locking prevents two workers/requests
--     from silently clobbering each other.
--  2. A partial unique index prevents a job from having more than one
--     PENDING/RUNNING execution at a time unless it opts into concurrency.
--  3. locked_by / locked_at let us detect a worker that died mid-execution
--     (a "stale" execution) and safely reclaim it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE job_type AS ENUM ('HTTP_CALL', 'WEBHOOK');
CREATE TYPE job_status AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

CREATE TABLE jobs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  description             TEXT,
  type                    job_type NOT NULL DEFAULT 'HTTP_CALL',
  status                  job_status NOT NULL DEFAULT 'ACTIVE',

  -- HTTP_CALL config (kept generic so WEBHOOK reuses the same executor)
  target_url              TEXT NOT NULL,
  http_method             TEXT NOT NULL DEFAULT 'GET',
  headers                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  body                    JSONB,
  timeout_ms              INTEGER NOT NULL DEFAULT 10000,

  -- Scheduling: standard 5-field cron. NULL = manual-trigger-only job.
  cron_expression         TEXT,
  next_run_at             TIMESTAMPTZ,

  -- Retry policy
  max_retries             INTEGER NOT NULL DEFAULT 3,
  retry_backoff_base_ms   INTEGER NOT NULL DEFAULT 2000,

  -- If false (default), only one PENDING/RUNNING execution allowed at a time.
  allow_concurrent_runs   BOOLEAN NOT NULL DEFAULT false,

  version                 INTEGER NOT NULL DEFAULT 1,  -- optimistic locking
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_owner ON jobs(owner_id);
CREATE INDEX idx_jobs_next_run ON jobs(next_run_at) WHERE status = 'ACTIVE' AND cron_expression IS NOT NULL;
CREATE INDEX idx_jobs_name_trgm ON jobs USING gin (to_tsvector('english', name));

CREATE TYPE execution_status AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE trigger_source AS ENUM ('SCHEDULE', 'MANUAL', 'RETRY');

CREATE TABLE executions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status            execution_status NOT NULL DEFAULT 'PENDING',
  trigger_source    trigger_source NOT NULL DEFAULT 'SCHEDULE',

  attempt_number    INTEGER NOT NULL DEFAULT 1,
  parent_execution_id UUID REFERENCES executions(id), -- links a retry to its original run

  -- Idempotency: a client-supplied key (or server-generated for manual runs)
  -- so "user clicks Run Now 5 times" collapses into one execution.
  idempotency_key   TEXT NOT NULL,

  -- Denormalized copy of jobs.allow_concurrent_runs, snapshotted at insert
  -- time. A partial UNIQUE index (below) can't reference a column on a
  -- different table, so we copy the one bit of config it needs onto the
  -- row it governs. Deliberate denormalization for DB-level correctness.
  enforce_single_inflight BOOLEAN NOT NULL DEFAULT true,

  -- Concurrency-safe claiming (see worker.ts): a worker claims a row via
  -- SELECT ... FOR UPDATE SKIP LOCKED, then stamps locked_by/locked_at.
  locked_by         TEXT,
  locked_at         TIMESTAMPTZ,

  scheduled_for     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,

  response_status   INTEGER,
  response_body     TEXT,       -- truncated on write, see executionService
  error_message     TEXT,
  duration_ms       INTEGER,

  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_executions_job ON executions(job_id, created_at DESC);
CREATE INDEX idx_executions_status ON executions(status);
CREATE INDEX idx_executions_claimable ON executions(status, scheduled_for) WHERE status = 'PENDING';
-- Detect stale RUNNING rows quickly (crashed worker reaper)
CREATE INDEX idx_executions_running_locked ON executions(locked_at) WHERE status = 'RUNNING';

-- Prevents duplicate executions for a job that doesn't allow concurrent runs.
-- This is enforced at the DB layer (not just app code) so it holds even
-- under race conditions between two API instances.
CREATE UNIQUE INDEX uq_job_single_inflight
  ON executions(job_id)
  WHERE status IN ('PENDING', 'RUNNING') AND enforce_single_inflight = true;

-- Idempotency key uniqueness per job: two "Run Now" clicks with the same
-- key become a no-op insert (ON CONFLICT DO NOTHING in the service layer).
CREATE UNIQUE INDEX uq_job_idempotency ON executions(job_id, idempotency_key);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
