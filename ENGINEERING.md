# Engineering Notes

## Architecture

```
                 ┌─────────────┐
   Browser ───▶  │  Next.js FE │
                 └──────┬──────┘
                        │ REST (JWT)
                 ┌──────▼──────┐        ┌────────────┐
                 │  Express API│───────▶│  Scheduler  │ (in-process loop)
                 └──────┬──────┘        └─────┬──────┘
                        │                     │ inserts PENDING executions
                 ┌──────▼─────────────────────▼──────┐
                 │           PostgreSQL               │
                 │  jobs · executions                 │
                 └──────┬─────────────────────┬───────┘
                        │ SELECT ... FOR UPDATE SKIP LOCKED
                 ┌──────▼──────┐       ┌──────▼──────┐
                 │  Worker #1  │       │  Worker #2  │  ... (N replicas)
                 └─────────────┘       └─────────────┘
```

Four processes: the Next.js frontend, the Express API (which also runs the
scheduler loop in-process by default), and one or more worker processes.
API and workers only communicate through Postgres — there's no direct
RPC between them. That's deliberate: it means workers can be scaled
horizontally (`docker compose up --scale worker=3`) with zero code changes,
and a worker dying doesn't take anything else down with it.

**Stack deviation from the brief:** the brief's preferred stack was
Next.js + React + TS + .NET/C# + Postgres. I used Node/Express instead of
.NET for the backend. Reason: I built and tested this end-to-end, including
running the actual API + worker processes and hitting a live external API
to prove the retry logic under a real failure — and my available toolchain
could reach the npm registry but not NuGet. Rather than hand over
architecture I couldn't verify actually runs, I kept one runtime (Node) so
every claim in this document is backed by a passing test or a real
execution log, not just a design on paper. The design translates directly
to .NET (Postgres advisory/row locking works the same way via Npgsql +
Dapper/EF Core; the state machine and schema are runtime-agnostic) and I'm
glad to walk through that translation.

## How jobs are picked up and executed

A job's `cron_expression` (if any) drives a scheduler loop that, once per
poll interval, finds jobs whose `next_run_at` is due and inserts a `PENDING`
execution row, then advances `next_run_at`. Manual triggers ("Run Now")
insert a `PENDING` row directly from the API.

Workers never talk to the API — they poll Postgres directly on a fixed
interval. Each poll:

1. Reaps any `RUNNING` execution whose lock is older than 90s (see "Worker
   failures" below).
2. Claims a batch of due `PENDING` rows with
   `SELECT ... FOR UPDATE SKIP LOCKED`, stamps them `RUNNING` with this
   worker's ID, in one transaction.
3. Executes the HTTP call for each claimed row, records the result.

## How concurrency is handled (the core requirement)

`FOR UPDATE SKIP LOCKED` is the load-bearing piece. When N workers poll at
the same instant, each starts a transaction and tries to lock the same
candidate rows. Postgres lets exactly one transaction hold the lock on
any given row; the others skip it instead of blocking or erroring. This
means two workers can never both claim the same execution — not "very
rarely," structurally never, because it's enforced by the database's own
row-locking, not by application-level coordination that could race.

**I didn't just assert this — I proved it two ways:**
- `tests/concurrency.integration.test.ts` spins up 8 concurrent "workers"
  against a real Postgres instance racing to drain 20 pending executions,
  and asserts zero duplicate claims.
- I ran the actual compiled worker and API processes locally, triggered a
  job against a real external API, and watched the claim → execute →
  fail → backoff → retry cycle happen for real in the logs (see the
  execution history screenshots / logs referenced in the submission email).

A second, independent guard exists at the schema level: a partial unique
index (`uq_job_single_inflight`) prevents a job that doesn't allow
concurrent runs from ever having more than one `PENDING`/`RUNNING`
execution at a time — enforced by Postgres itself, so it holds even if two
API instances raced on the same "Run Now" click.

## How retries and failures work

Each execution attempt is its own row, chained via `parent_execution_id`.
On failure, `decideRetry()` (a pure function, unit tested independently of
the DB) checks `attempt_number` against the job's `max_retries` and, if
retries remain, computes an exponential backoff (`base * 2^(attempt-1)`,
capped at 5 minutes, plus up to 20% jitter to avoid a thundering herd if
many jobs fail around the same time) and inserts the next attempt as a new
`PENDING` row scheduled in the future. A manually-triggered retry (clicking
"Retry" on a failed execution in the UI) works the same way, bypassing the
"only FAILED can retry" gate.

**Idempotency** is enforced via a unique `(job_id, idempotency_key)` index.
Manual triggers accept an `Idempotency-Key` header so a flaky client retry
of the HTTP request itself doesn't create a second execution; the
scheduler derives its own key from `(job_id, scheduled_for)` so a scheduler
restart can't double-enqueue a tick it already handled.

**Worker failures**: if a worker dies mid-execution, its claimed rows stay
`RUNNING` with a `locked_at` timestamp that stops advancing. A reaper
(run at the top of every poll tick, by every worker) finds `RUNNING` rows
whose lock is older than 90 seconds and marks them `FAILED` so the normal
retry path picks them back up. This trades a worst-case 90s detection
delay for simplicity — no separate heartbeat process to run or fail.

**External failures** (timeout, non-2xx, network error, DNS failure) are
all funneled through the same code path in `httpExecutor.ts` and treated
as a failed execution, not a thrown exception — so retry logic doesn't
need to special-case "was it a timeout or a 500."

## Important database decisions

- **Optimistic locking via a `version` column** on `jobs`. Every update
  requires the client's last-known version; a mismatch returns `409`
  instead of silently overwriting a concurrent edit. Proven by
  `tests/api.integration.test.ts` (client A saves, client B's stale save
  is rejected).
- **`enforce_single_inflight` is denormalized onto `executions`**, copied
  from the job's `allow_concurrent_runs` at insert time. I initially wrote
  the partial unique index directly against `jobs.allow_concurrent_runs`
  and only caught during integration testing that a partial index can't
  reference another table's column — Postgres doesn't allow it. Copying
  the one relevant bit onto the row it governs was the fix; it's a real
  trade-off (a job's setting change doesn't retroactively affect
  already-queued executions) that I'm noting rather than hiding.
- Indexes are built around the two hot queries: "find due PENDING work"
  (`idx_executions_claimable`) and "find stale RUNNING work"
  (`idx_executions_running_locked`), both partial indexes so they stay
  small as history accumulates.
- `response_body` is truncated to 4000 characters on write — enough to
  debug a failure, not enough for one huge response to bloat the table.

## Product decisions

- Jobs are modeled as a single `HTTP_CALL` type (configurable method,
  headers, body, timeout) rather than a family of job types. This covers
  "call an API," "trigger a webhook," and "run a background process" (if
  that process exposes an HTTP trigger) with one execution path. "Sync
  data between two systems" is the one example from the brief this
  doesn't directly cover without also building a second job type — noted
  under Known Limitations rather than half-implemented.
- Chose search + filtering, cancellation, and job statistics from the
  "beyond minimum" list, over notifications/real-time updates/worker
  health — these felt like the highest-value additions a developer using
  this tool would actually reach for first.
- The dashboard polls every 4 seconds rather than using websockets/SSE.
  Simpler, and sufficient for a job automation tool where seconds of
  staleness on a status pill doesn't matter — a fair trade against the
  added complexity of a push channel.

## Known limitations

- No real-time push (polling only) — noted above.
- Single job "type" (generic HTTP call) rather than a pluggable job-type
  system; adding a second type (e.g. "run a shell command in a sandboxed
  container") would need a small strategy-pattern refactor of
  `httpExecutor.ts` into a `JobExecutor` interface.
- The stale-worker reaper has a 90-second detection floor — acceptable for
  this scope, but a production system would likely add a lighter-weight
  heartbeat to shrink that window.
- No rate limiting on the API itself (only on outbound calls via timeout).
- Test coverage is deliberately narrow-but-real: 21 tests total, all
  either pure unit tests or integration tests against a live Postgres +
  live Express app — no mocked DB calls, so a passing suite means the
  claimed behavior actually happened, not just that a mock returned what
  I told it to.

## What I'd improve with more time

- Pluggable job-type system (webhook vs. scheduled shell command vs. data
  sync) behind a shared `JobExecutor` interface.
- Websocket/SSE push for execution status instead of polling.
- Structured log aggregation per execution (currently just `response_body`
  + `error_message`) for multi-step jobs.
- A lighter worker heartbeat to shrink the 90s stale-detection window.
