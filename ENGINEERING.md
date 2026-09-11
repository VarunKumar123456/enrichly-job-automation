# Engineering Notes

## 1. Architecture

```text
                         Browser
                            |
                            | REST + JWT
                            v
                  +----------------------+
                  |      Next.js FE      |
                  +----------+-----------+
                             |
                             | HTTP
                             v
                  +----------------------+
                  |      Express API     |
                  |                      |
                  |  Scheduler loop      |
                  |  Worker loop         |
                  +----------+-----------+
                             |
                             | PostgreSQL
                             v
                  +----------------------+
                  |     PostgreSQL       |
                  |                      |
                  | jobs                 |
                  | executions           |
                  +----------------------+
```

The system has three logical layers:

1. **Frontend** — Next.js/React UI for authentication, job management, execution history, filtering, retrying, and cancellation.
2. **API** — Express/TypeScript REST API responsible for authentication, authorization, validation, job CRUD, manual execution requests, and scheduler/worker lifecycle.
3. **PostgreSQL** — persistent source of truth for job configuration, execution state, locking, idempotency, retries, and history.

The worker implementation is separated into its own module and can run independently from the API.

### Production deployment trade-off

The production deployment runs the scheduler and one worker loop inside the API Node.js process.

This was an intentional free-tier deployment decision.

Render's free web-service tier does not provide a free dedicated Background Worker service. Rather than deploy an architecture that required a paid service, the application keeps the execution worker logically separated in code while allowing it to run in-process.

The worker lifecycle is controlled through:

```text
startWorker()
stopWorker()
```

and environment configuration:

```text
RUN_WORKER_IN_API=true
```

This means the production deployment can remain on the free tier without changing the execution model itself.

If deployed to infrastructure with dedicated background workers, the worker can be run as a separate process using the same database coordination mechanism.

---

# 2. Stack

The assignment's preferred stack was:

```text
Next.js + React + TypeScript + .NET/C# + PostgreSQL
```

I used:

```text
Next.js + React + TypeScript
Node.js + Express + TypeScript
PostgreSQL
```

The frontend matches the preferred stack directly.

The backend differs from the preferred .NET/C# choice.

## Why Node instead of .NET?

The primary reason was execution confidence.

I wanted to verify the complete system end-to-end rather than provide a partially verified implementation. The available development environment had a reliable Node/npm toolchain, while the NuGet tooling required for the preferred backend was not available for the same workflow.

Using Node allowed me to:

* Build the API completely
* Run the worker locally
* Run PostgreSQL integration tests
* Exercise real concurrent claims
* Test retries against a real external HTTP endpoint
* Deploy the API and worker logic
* Verify the production deployment

The important architectural pieces are runtime-independent:

* PostgreSQL transactions
* Row locking
* `FOR UPDATE SKIP LOCKED`
* Unique constraints
* Idempotency
* Optimistic locking
* Execution state transitions
* Retry chains

A .NET implementation would use the same database model and concurrency semantics, for example through Npgsql with Dapper or EF Core.

The decision was therefore to submit a fully working and tested Node implementation rather than an unverified .NET implementation.

---

# 3. Job model

A job represents an HTTP-based automated task.

The current job type is intentionally:

```text
HTTP_CALL
```

It can represent:

* REST API calls
* Webhooks
* External service triggers

A job contains configuration such as:

* Name
* Description
* Target URL
* HTTP method
* Headers
* Request body
* Timeout
* Cron expression
* Maximum retries
* Retry backoff
* Concurrent-run policy

This keeps the implementation focused on the central automation problem instead of introducing multiple partially implemented job types.

---

# 4. Execution model

Every execution attempt is represented by a row in the `executions` table.

An execution includes:

* Job ID
* Status
* Trigger source
* Attempt number
* Parent execution ID
* Idempotency key
* Scheduled timestamp
* Worker lock information
* Start/finish timestamps
* Response status
* Response body snippet
* Error message
* Duration
* Version

The execution status lifecycle is approximately:

```text
PENDING
   |
   | worker claims
   v
RUNNING
   |
   +---------> SUCCEEDED
   |
   +---------> FAILED
                   |
                   | retry available
                   v
                 PENDING
```

Each retry is a new execution row.

This provides a complete audit trail instead of overwriting the original failed attempt.

---

# 5. How jobs are scheduled

Jobs may optionally contain a cron expression.

The scheduler loop runs periodically.

On each scheduler iteration:

1. Find active jobs whose `next_run_at` is due.
2. Lock the candidate job row.
3. Insert a `PENDING` execution.
4. Generate a deterministic idempotency key based on the job and scheduled timestamp.
5. Advance `next_run_at`.
6. Commit the transaction.

The scheduler uses database locking so multiple scheduler instances can safely compete for due jobs.

The deterministic idempotency key prevents the same scheduled tick from being inserted twice.

---

# 6. How manual execution works

The **Run Now** API endpoint creates a `PENDING` execution.

The request:

1. Authenticates the user.
2. Verifies that the user owns the job.
3. Validates the request.
4. Determines the idempotency key.
5. Determines whether the job allows overlapping executions.
6. Inserts the execution.
7. Returns the created/deduplicated execution result.

Manual execution requests support an `Idempotency-Key` header.

If a client retries the same HTTP request because of a timeout or network problem, the same idempotency key prevents a second execution from being created.

---

# 7. Worker pickup

Workers poll PostgreSQL for pending work.

A worker performs three main actions on each tick:

1. Reap stale executions.
2. Claim pending executions.
3. Execute the claimed HTTP calls.

The claim query uses:

```sql
SELECT ...
FROM executions
JOIN jobs ...
WHERE executions.status = 'PENDING'
  AND executions.scheduled_for <= now()
  AND jobs.status = 'ACTIVE'
ORDER BY executions.scheduled_for
LIMIT ...
FOR UPDATE OF executions SKIP LOCKED
```

The selected executions are then changed to:

```text
RUNNING
```

with:

* `locked_by`
* `locked_at`
* `started_at`

The claim and state transition happen in the same transaction.

---

# 8. Concurrency: `FOR UPDATE SKIP LOCKED`

This is the load-bearing concurrency mechanism.

Suppose multiple workers poll at the same time:

```text
Worker A ──┐
Worker B ──┼──> PostgreSQL
Worker C ──┘
```

All workers may find the same pending rows.

PostgreSQL row locking ensures that only one transaction can hold the lock on a given execution.

Other workers use:

```sql
SKIP LOCKED
```

so they skip rows already claimed by another transaction.

The result is:

```text
Execution 1 → Worker A
Execution 2 → Worker B
Execution 3 → Worker C
```

rather than:

```text
Execution 1 → Worker A
Execution 1 → Worker B
Execution 1 → Worker C
```

This guarantee is provided by the database rather than application-level timing assumptions.

---

# 9. Concurrency testing

The concurrency behavior is tested against a real PostgreSQL instance.

`concurrency.integration.test.ts` creates pending executions and starts multiple concurrent claimers.

The test verifies:

* Multiple workers can race for pending work.
* Workers do not claim the same execution.
* All executions can be drained.
* Duplicate claims are zero.

The test intentionally does not mock PostgreSQL locking behavior.

This is important because a mock cannot prove that the actual database transaction semantics work correctly.

---

# 10. Single in-flight execution

The product provides a job-level option controlling whether overlapping executions are allowed.

When overlapping executions are disabled, the database contains a partial unique index:

```text
uq_job_single_inflight
```

It applies to executions in:

```text
PENDING
RUNNING
```

This means PostgreSQL itself prevents a job from having two active executions simultaneously.

For example:

```text
Job A
 |
 +-- Execution 1 → RUNNING
 |
 +-- Execution 2 → rejected
```

This is stronger than performing a simple application-level:

```text
if (alreadyRunning) ...
```

check, because two API requests could otherwise race between the check and insert.

The database constraint closes that race.

---

# 11. Denormalized concurrency flag

The execution table stores:

```text
enforce_single_inflight
```

This is copied from the job's `allow_concurrent_runs` setting when an execution is created.

The reason is a PostgreSQL limitation: a partial index cannot directly reference a column from another table.

An initial design attempted to make the index depend directly on:

```text
jobs.allow_concurrent_runs
```

but PostgreSQL does not allow that.

The relevant setting was therefore denormalized onto executions.

This has one deliberate consequence:

> Changing a job's concurrency setting does not retroactively change the policy stored on already-created execution rows.

That trade-off is preferable to removing the database-level guarantee.

---

# 12. Idempotency

There are two main idempotency cases.

## Manual requests

Manual execution requests can provide:

```text
Idempotency-Key
```

The database has a unique constraint on:

```text
(job_id, idempotency_key)
```

Repeated requests with the same key therefore resolve to the same logical execution rather than creating duplicates.

## Scheduled executions

The scheduler derives an idempotency key from:

```text
job_id + scheduled_for
```

This means a scheduler restart cannot blindly enqueue the same scheduled tick twice.

---

# 13. Retry design

Failures are handled by a pure retry-policy function.

The policy considers:

* Current attempt number
* Maximum retries
* Base backoff

When a retry is available, a new execution row is created.

The retry is linked to the failed attempt through:

```text
parent_execution_id
```

This produces an execution chain:

```text
Manual #1
    |
    v
Retry #2
    |
    v
Retry #3
    |
    v
Retry #4
```

The UI can therefore show the complete history.

---

# 14. Exponential backoff

Retry delay uses exponential backoff:

```text
base * 2^(attempt - 1)
```

with:

* A maximum delay cap
* Jitter

Jitter reduces the risk of many failed jobs retrying at exactly the same instant.

For example, instead of:

```text
1000ms
2000ms
4000ms
8000ms
```

many jobs will have slightly different retry times.

The retry policy is implemented as a pure function and tested independently.

---

# 15. Worker failure recovery

A worker may crash after claiming an execution.

Without recovery, the execution could remain:

```text
RUNNING
```

forever.

Each claimed execution therefore records:

```text
locked_at
locked_by
```

Every worker periodically checks for stale locks.

An execution whose lock is older than the configured stale threshold is considered abandoned.

The current threshold is:

```text
90 seconds
```

The reaper:

1. Finds stale `RUNNING` executions.
2. Marks them `FAILED`.
3. Records a worker-crash error message.
4. Applies the normal retry policy.
5. Creates the next retry when retries remain.

This means worker crashes use the same recovery path as normal failures.

---

# 16. Why 90 seconds?

The 90-second threshold is a deliberate trade-off.

A shorter threshold gives faster recovery but increases the risk of incorrectly declaring a genuinely slow execution dead.

A longer threshold improves safety but delays recovery.

For this take-home application, 90 seconds is a reasonable balance.

A production system could replace or supplement this with:

* Worker heartbeats
* Lease renewal
* Process health monitoring
* Dedicated queue infrastructure

---

# 17. External HTTP failures

The HTTP executor treats several failure categories as execution failures:

* Non-2xx responses
* Timeouts
* DNS errors
* Connection failures
* Network errors

They are normalized into an execution result rather than allowing retry logic to depend on the exact exception type.

This keeps retry behavior centralized.

A failure can therefore follow:

```text
HTTP call
   |
   +-- 500
   |
   +-- timeout
   |
   +-- DNS failure
   |
   +-- network error
         |
         v
      FAILED
         |
         v
    retry policy
```

---

# 18. Response storage

The response body is truncated before storage.

The current limit is:

```text
4000 characters
```

The goal is to preserve enough response information to diagnose failures without allowing one very large HTTP response to unnecessarily consume database storage.

---

# 19. Optimistic locking

Jobs contain a `version` column.

When a client reads a job, it also receives its current version.

An update includes the expected version.

Conceptually:

```sql
UPDATE jobs
SET ...
    version = version + 1
WHERE id = $1
  AND version = $expectedVersion
```

If no row is updated, another client has changed the job.

The API returns:

```text
409 Conflict
```

instead of silently overwriting the newer change.

This behavior is covered by integration tests.

---

# 20. Authentication and authorization

Authentication uses:

```text
bcrypt
JWT
```

Users authenticate through the API and receive a JWT.

Protected routes require authentication.

Job ownership is checked before operations such as:

* Reading jobs
* Updating jobs
* Deleting jobs
* Running jobs
* Reading execution history
* Retrying executions
* Cancelling executions

This prevents users from operating on another user's jobs simply by changing an ID in the URL.

---

# 21. Validation

API inputs are validated before database operations.

Validation covers areas such as:

* Job names
* URLs
* HTTP methods
* Timeouts
* Retry counts
* Retry backoff
* Cron expressions
* Request bodies
* Concurrency settings

Invalid requests return structured client errors instead of allowing malformed data to reach database queries.

---

# 22. Error handling

The API uses centralized error handling.

Expected errors are converted into appropriate HTTP responses.

Examples include:

```text
400 Bad Request
401 Unauthorized
403 Forbidden
404 Not Found
409 Conflict
```

Unexpected errors are logged by the backend rather than exposed as raw internal implementation details.

---

# 23. Database decisions

PostgreSQL was selected because the assignment's hardest problems are state and concurrency problems rather than simple CRUD.

Important database responsibilities include:

* Persistent job state
* Execution history
* Transaction boundaries
* Worker locking
* Idempotency
* Single-inflight guarantees
* Optimistic locking
* Retry chains
* Scheduler coordination

Raw SQL through `pg` was chosen instead of an ORM because the concurrency-critical queries are clearer when their PostgreSQL locking semantics are explicit.

---

# 24. Indexing

Indexes focus on the application's hot paths.

### Claimable executions

A partial index supports:

```text
PENDING executions
```

that are eligible for worker pickup.

### Stale executions

Another partial index supports:

```text
RUNNING executions
```

with lock timestamps.

Partial indexes keep these hot query paths focused even as execution history grows.

---

# 25. Migrations

Database schema changes are stored in the migrations directory.

The initial migration creates:

* Extensions
* Enum types
* Jobs table
* Executions table
* Indexes
* Constraints
* Triggers/functions where required

The schema is therefore reproducible rather than depending on manually created database objects.

---

# 26. Product decisions

The assignment intentionally leaves the product underdefined.

I chose to focus the UI around the developer/operator workflow:

```text
Create job
    ↓
Run or schedule job
    ↓
Monitor execution
    ↓
Understand failure
    ↓
Retry / cancel / inspect history
```

The dashboard provides:

* Job status
* Execution statistics
* Search
* Filtering
* Execution history
* Failure information

---

# 27. Why HTTP jobs?

A generic HTTP job can represent:

* REST API calls
* Webhooks
* Third-party service triggers
* Internal automation endpoints

This gives useful automation coverage without building multiple execution engines.

The assignment mentions broader possibilities such as data synchronization.

That would require additional job types and execution strategies, so it is explicitly treated as a future extension rather than a partially implemented feature.

---

# 28. Cancellation

Execution cancellation was chosen as one of the higher-value features beyond the basic CRUD requirements.

It gives an operator control over work that has been queued but is no longer desirable.

The implementation focuses on reliable database state transitions rather than pretending to guarantee cancellation of an already-completed external HTTP request.

---

# 29. Dashboard polling

The frontend polls execution/job data approximately every four seconds.

I deliberately chose polling instead of WebSockets or Server-Sent Events.

The reasoning is:

* The application does not require sub-second status updates.
* Polling is simpler to deploy.
* Polling reduces backend infrastructure complexity.
* It keeps the real-time layer out of the critical execution path.

For a larger production system, SSE or WebSockets would be a natural improvement.

---

# 30. Testing strategy

The test suite contains:

```text
21 tests
3 suites
```

The testing strategy prioritizes the risky parts of the system rather than maximizing superficial line coverage.

### Unit tests

The retry policy is tested independently.

### Concurrency integration tests

Real PostgreSQL is used to verify:

* Concurrent worker claims
* `SKIP LOCKED`
* No duplicate execution claims
* Single-inflight protection

### API integration tests

The real Express application is exercised for:

* Authentication
* Optimistic locking
* Idempotency
* Retry behavior
* Job operations

The intent is to prove system behavior rather than simply test mocked functions.

---

# 31. Real execution verification

In addition to automated tests, the application was exercised against real HTTP endpoints.

A successful execution was verified against:

```text
https://api.github.com
```

A failure/retry path was verified against:

```text
https://httpbin.org/status/500
```

The production deployment was also exercised after deployment.

This verified the complete path:

```text
Browser
  ↓
API
  ↓
PostgreSQL
  ↓
Worker
  ↓
External HTTP endpoint
  ↓
Execution result
  ↓
History UI
```

---

# 32. Failure scenarios

| Scenario                         | Handling                                                  |
| -------------------------------- | --------------------------------------------------------- |
| Two workers claim same execution | `FOR UPDATE SKIP LOCKED`                                  |
| Two Run Now requests             | Partial unique single-inflight constraint                 |
| Client repeats same request      | Idempotency key                                           |
| Two clients edit same job        | Optimistic locking                                        |
| HTTP 500                         | Failed execution + retry policy                           |
| HTTP timeout                     | Failed execution + retry policy                           |
| DNS/network failure              | Failed execution + retry policy                           |
| Worker crashes                   | Stale lock reaper                                         |
| Scheduler restarts               | Deterministic scheduling idempotency key                  |
| Invalid cron                     | Job configuration validation/error handling               |
| Database unavailable             | API/worker logs failure and retries on subsequent polling |
| External service unavailable     | Execution fails and normal retry policy applies           |

---

# 33. Production deployment

The application is deployed using Render.

The production setup contains:

```text
Render Web Service
    |
    +-- Express API
    +-- Scheduler loop
    +-- Worker loop
             |
             v
       Render PostgreSQL
```

The frontend is deployed as a separate Render web service.

This arrangement was selected to remain within the free-tier constraints.

The worker is not deployed as a separate paid Background Worker in production.

That is an infrastructure decision, not a change to the worker's logical architecture.

---

# 34. Why the worker remains separate in code

The worker has its own module and lifecycle:

```text
startWorker()
stopWorker()
```

This preserves a clean separation between:

```text
API responsibilities
Worker responsibilities
```

The API does not directly execute HTTP jobs.

Instead:

```text
API
  ↓
PostgreSQL
  ↓
Worker
```

The same boundary remains valid whether the worker is:

```text
inside the API process
```

or:

```text
a separate process
```

This makes the deployment model flexible.

---

# 35. Known limitations

## No WebSocket/SSE

The UI uses polling.

This is sufficient for the assignment but introduces a small delay between backend state changes and UI updates.

---

## One job type

The system currently supports HTTP calls.

A production automation platform would likely expose a job executor abstraction:

```text
JobExecutor
   |
   +-- HttpExecutor
   +-- WebhookExecutor
   +-- DataSyncExecutor
   +-- ...
```

---

## 90-second stale recovery

Worker failure detection currently has a 90-second threshold.

A heartbeat/lease mechanism would reduce the recovery window.

---

## No API rate limiting

The current API does not include a full rate-limiting layer.

A production deployment should add:

* Request rate limits
* Per-user limits
* Abuse protection
* Outbound concurrency limits

---

## No dedicated distributed queue

PostgreSQL acts as the work coordination mechanism.

For this assignment, that keeps the architecture small and understandable.

At significantly larger scale, a dedicated queue could become preferable.

---

## Test scope

There are 21 tests focused on high-risk behavior.

The suite deliberately prioritizes:

* Concurrency
* Retry behavior
* Idempotency
* Optimistic locking
* Authentication

rather than attempting broad end-to-end coverage of every UI interaction.

---

# 36. What I would improve with more time

### 1. Dedicated queue

Introduce a durable queue such as a managed message broker for larger-scale workloads.

### 2. Worker heartbeat

Add worker leases/heartbeats to reduce stale execution recovery time.

### 3. Real-time execution updates

Use SSE/WebSockets so execution status changes reach the UI immediately.

### 4. Pluggable executors

Introduce a common `JobExecutor` interface for multiple job types.

### 5. Structured execution logs

Store structured logs per execution rather than only response snippets and error messages.

### 6. Rate limiting

Add API and outbound execution rate controls.

### 7. Better observability

Add:

* Metrics
* Structured logs
* Execution latency metrics
* Retry counts
* Worker health
* Alerting

---

# 37. Engineering trade-offs

The main trade-offs were:

| Decision                      | Benefit                                      | Cost                                    |
| ----------------------------- | -------------------------------------------- | --------------------------------------- |
| PostgreSQL as queue           | Simple infrastructure and strong consistency | Less specialized than a dedicated queue |
| Raw SQL                       | Explicit concurrency behavior                | More SQL maintenance                    |
| `SKIP LOCKED`                 | Strong multi-worker coordination             | PostgreSQL-specific                     |
| Single-inflight DB constraint | Race-safe guarantee                          | Requires denormalized flag              |
| Retry rows                    | Complete audit trail                         | More execution records                  |
| Polling UI                    | Simple deployment                            | Small status delay                      |
| HTTP-only jobs                | Focused implementation                       | Less extensible job model               |
| In-process production worker  | Works on free Render tier                    | API and worker share a process          |
| 90s stale threshold           | Simple crash recovery                        | Recovery is not immediate               |
| 21 targeted tests             | Strong coverage of risky behavior            | Not exhaustive UI coverage              |

The guiding principle was:

> Prefer a smaller system whose correctness can be demonstrated over a larger system whose reliability is mostly theoretical.

---

# 38. Final architecture summary

The key design choice is that PostgreSQL is not merely the application's CRUD database.

It is also the coordination mechanism for distributed execution.

The critical guarantees are enforced at the database level:

```text
              PostgreSQL
                   |
       +-----------+-----------+
       |           |           |
   Row locks   Unique keys  Versions
       |           |           |
       v           v           v
   Worker       Idempotency  Optimistic
   claims                    locking
```

This allows multiple worker processes to safely compete for work while preventing duplicate execution.

The worker failure path feeds back into the same retry mechanism as normal execution failures.

The production free-tier deployment runs the scheduler and worker inside the API process, but the logical worker boundary and database coordination remain intact.

The result is a deliberately scoped automation platform focused on the assignment's highest-risk engineering requirements:

* Correct execution
* Concurrency
* Idempotency
* Retries
* Failure recovery
* Authentication/authorization
* Database consistency
* Testing
* Deployability
