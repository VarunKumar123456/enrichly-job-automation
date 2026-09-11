# Job Automation Platform

A web app for creating, running, and monitoring automated jobs (scheduled or manually triggered HTTP calls / webhooks), built for the Enrichly Full Stack Developer Intern take-home assignment.

The application supports:

* User authentication
* Job creation and management
* Manual and scheduled execution
* Execution history
* Retry handling with exponential backoff
* Failure inspection
* Search and filtering
* Execution cancellation
* Job statistics
* Concurrent worker-safe execution
* Idempotent execution requests
* Optimistic locking for concurrent job updates
* Recovery of executions left behind by a crashed worker

Architecture, concurrency design, database decisions, reliability behavior, and trade-offs are documented in [`ENGINEERING.md`](./ENGINEERING.md).

---

## Stack

* **Frontend:** Next.js 14 (App Router) + React + TypeScript + Tailwind CSS
* **Backend:** Node.js + Express + TypeScript
* **Database:** PostgreSQL
* **Database access:** `pg` with raw SQL (no ORM)
* **Execution engine:** Node.js worker loop
* **Authentication:** JWT + bcrypt
* **Deployment:** Render
* **Containerization:** Docker / Docker Compose

### Stack deviation from the preferred stack

The assignment's preferred backend stack is .NET/C#.

I used Node.js + Express + TypeScript instead.

The reason was to build and verify the complete system end-to-end with the available toolchain, including the API, scheduler, worker, PostgreSQL concurrency behavior, retry handling, and live external HTTP execution.

The concurrency model, database schema, state machine, and API boundaries are runtime-independent and map directly to a .NET implementation using Npgsql with Dapper or EF Core.

The architectural reasoning and trade-off are documented in detail in `ENGINEERING.md`.

---

# Architecture

The application has three logical layers:

```text
                    Browser
                       |
                       | REST + JWT
                       v
              +-------------------+
              |    Next.js FE     |
              +---------+---------+
                        |
                        | HTTP
                        v
              +-------------------+
              |   Express API     |
              |                   |
              |  Scheduler loop   |
              |  Worker loop      |
              +---------+---------+
                        |
                        | PostgreSQL
                        v
              +-------------------+
              |    PostgreSQL     |
              |                   |
              | jobs              |
              | executions        |
              +-------------------+
```

The worker implementation is deliberately separated in code from the API, so it can run as an independent process or multiple replicas.

### Local development

Docker Compose can run the API, scheduler, frontend, PostgreSQL, and worker as separate processes.

Multiple worker replicas can be started to exercise the concurrency guarantees:

```bash
docker compose up --build --scale worker=3
```

### Production deployment

The deployed Render free-tier configuration runs the scheduler and one worker loop **inside the API Node.js process**.

This is an intentional deployment trade-off because Render's free tier does not provide a free Background Worker service.

The worker code remains independently structured through `startWorker()` / `stopWorker()`, so moving it to a dedicated background-worker service or scaling it horizontally requires deployment configuration changes rather than redesigning the execution model.

PostgreSQL remains the coordination layer and continues to enforce execution ownership through row locking and database constraints.

---

# Running locally with Docker

Docker and Docker Compose are recommended.

### Requirements

* Docker
* Docker Compose

Clone the repository:

```bash
git clone https://github.com/VarunKumar123456/enrichly-job-automation.git
cd enrichly-job-automation
```

Start the application:

```bash
docker compose up --build
```

This starts:

* PostgreSQL
* Database migration
* Express API on port `4000`
* Worker
* Next.js frontend on port `3000`

Open:

```text
http://localhost:3000
```

Create an account, create a job, and click **Run now**.

---

# Testing multiple workers locally

The execution system is designed so multiple workers can safely compete for pending executions.

Run:

```bash
docker compose up --build --scale worker=3
```

Each worker polls PostgreSQL for pending work.

Workers claim executions using:

```sql
SELECT ...
FOR UPDATE SKIP LOCKED
```

This allows workers to compete for work without claiming the same execution.

The database-level locking mechanism is supplemented by a partial unique constraint for jobs configured to allow only one in-flight execution.

See `ENGINEERING.md` for the detailed concurrency design.

---

# Running locally without Docker

PostgreSQL 14+ is required.

## 1. Database

Create the database:

```bash
createdb enrichly
```

From the `backend` directory:

```bash
cd backend
```

Copy the environment file:

```bash
cp .env.example .env
```

Update `.env` with your local PostgreSQL connection string.

Install dependencies:

```bash
npm install
```

Run migrations:

```bash
npm run migrate
```

---

## 2. Start the backend API

From `backend/`:

```bash
npm run dev
```

The API runs on:

```text
http://localhost:4000
```

---

## 3. Start the worker

Open a second terminal.

From `backend/`:

```bash
npm run worker:dev
```

---

## 4. Start the frontend

Open a third terminal:

```bash
cd frontend
```

Copy the frontend environment file:

```bash
cp .env.example .env.local
```

Install dependencies:

```bash
npm install
```

Start Next.js:

```bash
npm run dev
```

The application runs on:

```text
http://localhost:3000
```

---

# Running tests

The backend contains unit and integration tests.

From `backend/`:

```bash
npm install
```

Set a test database:

```bash
export DATABASE_URL=postgresql://user:pass@localhost:5432/enrichly_test
export JWT_SECRET=test-secret
```

Then run:

```bash
npm test
```

> Do not point the test suite at production data.

The test suite contains **21 tests across 3 suites**.

### `retryPolicy.test.ts`

Pure unit tests for:

* Retry decisions
* Attempt numbering
* Exponential backoff
* Retry limits

No database is required.

### `concurrency.integration.test.ts`

Runs concurrency tests against a real PostgreSQL instance.

It verifies:

* Multiple workers competing for the same pending executions
* `FOR UPDATE SKIP LOCKED`
* No duplicate claims
* Single-inflight database protection

The concurrency behavior is tested against PostgreSQL rather than mocked.

### `api.integration.test.ts`

Integration tests against the real Express application covering:

* Authentication
* Job operations
* Optimistic locking conflicts
* Idempotency
* Retry behavior
* API execution behavior

---

# Environment variables

## Backend

Create:

```text
backend/.env
```

using:

```text
backend/.env.example
```

| Variable                     | Description                               | Default                |
| ---------------------------- | ----------------------------------------- | ---------------------- |
| `DATABASE_URL`               | PostgreSQL connection string              | Required               |
| `JWT_SECRET`                 | Secret used to sign authentication tokens | Required in production |
| `PORT`                       | API port                                  | `4000`                 |
| `DB_POOL_MAX`                | Maximum PostgreSQL pool connections       | `10`                   |
| `WORKER_POLL_INTERVAL_MS`    | Worker polling interval                   | `2000`                 |
| `WORKER_BATCH_SIZE`          | Maximum executions claimed per poll       | `5`                    |
| `SCHEDULER_POLL_INTERVAL_MS` | Scheduler polling interval                | `5000`                 |
| `RUN_SCHEDULER_IN_API`       | Run scheduler inside the API process      | `true`                 |
| `RUN_WORKER_IN_API`          | Run worker inside the API process         | `true`                 |
| `WORKER_NAME`                | Worker identifier prefix                  | `worker`               |

---

## Frontend

Create:

```text
frontend/.env.local
```

using:

```text
frontend/.env.example
```

| Variable              | Description                 | Default                 |
| --------------------- | --------------------------- | ----------------------- |
| `NEXT_PUBLIC_API_URL` | Base URL of the backend API | `http://localhost:4000` |

---

# API documentation

The API documentation is available in:

```text
API.md
```

The API exposes endpoints for:

* Authentication
* Job creation and management
* Manual execution
* Execution history
* Retry operations
* Execution cancellation

Authentication uses JWT bearer tokens.

---

# Database

PostgreSQL stores:

### Jobs

Job configuration including:

* Name
* Description
* HTTP target
* HTTP method
* Headers
* Request body
* Timeout
* Cron expression
* Retry configuration
* Concurrency configuration
* Version

### Executions

Each execution attempt is stored separately.

Execution records contain:

* Job ID
* Status
* Trigger source
* Attempt number
* Parent execution
* Idempotency key
* Scheduled time
* Worker lock information
* Start/finish timestamps
* HTTP response information
* Error information
* Duration

This makes execution history auditable and makes retry chains visible.

---

# Reliability and concurrency

The execution system is intentionally database-driven.

Workers claim pending executions using:

```sql
FOR UPDATE SKIP LOCKED
```

This prevents multiple workers from claiming the same execution.

For jobs configured as **single-run at a time**, PostgreSQL additionally enforces:

```text
One PENDING or RUNNING execution per job
```

through a partial unique index.

Manual execution requests also support idempotency keys so repeated HTTP requests do not create duplicate executions.

Job updates use optimistic locking through a version column.

Worker failures are handled by a stale-lock reaper. If a worker disappears while processing an execution, another worker can reclaim the stale execution and send it through the normal retry policy.

See `ENGINEERING.md` for the complete design.

---

# Retry behavior

Failed executions can be retried according to the job's retry configuration.

Retry scheduling uses:

* Exponential backoff
* A maximum backoff cap
* Jitter
* Attempt numbers
* Parent/child execution relationships

For example:

```text
Attempt #1
    |
    | failure
    v
Attempt #2
    |
    | failure
    v
Attempt #3
```

Each attempt remains independently visible in execution history.

This makes it possible to distinguish:

* The original failure
* Individual retry attempts
* Final retry exhaustion

---

# Scheduled jobs

Jobs may optionally contain a cron expression.

The scheduler:

1. Finds active jobs whose `next_run_at` is due.
2. Creates a pending execution.
3. Advances `next_run_at`.
4. Uses an idempotency key derived from the job and scheduled timestamp.

This prevents duplicate scheduling when multiple scheduler iterations race or when the scheduler restarts.

Invalid cron expressions are handled as job configuration errors rather than silently producing incorrect schedules.

---

# Failure handling

The system treats several failure categories consistently:

* HTTP non-2xx responses
* Request timeouts
* Network failures
* DNS failures
* External API failures
* Worker crashes
* Duplicate requests
* Concurrent execution attempts
* Concurrent job updates

HTTP/network failures become failed executions and are passed through the retry policy.

A worker that crashes during an execution leaves a stale lock. The reaper detects the stale execution and sends it through the retry policy.

---

# Deployment

The live application is deployed on Render.

## Current production architecture

```text
                 +----------------------+
                 |      Render Web      |
                 |                      |
Browser -------> | Next.js Frontend     |
                 +----------+-----------+
                            |
                            v
                 +----------------------+
                 |      Render Web      |
                 |                      |
                 | Express API          |
                 | Scheduler            |
                 | Worker               |
                 +----------+-----------+
                            |
                            v
                 +----------------------+
                 | Render PostgreSQL    |
                 +----------------------+
```

The production API process starts:

* Express API
* Scheduler loop
* Worker loop

This is controlled by:

```text
RUN_SCHEDULER_IN_API=true
RUN_WORKER_IN_API=true
```

This arrangement keeps the application deployable on the Render free tier while preserving the worker's database-coordinated execution model.

---

# Docker

The repository includes Dockerfiles for the frontend and backend and a Docker Compose configuration for local development.

The Docker Compose setup can run multiple workers:

```bash
docker compose up --build --scale worker=3
```

This is useful for exercising the concurrency guarantees locally.

---

# Live application

**Live application:**

https://enrichly-frontend.onrender.com

**Backend health endpoint:**

https://enrichly-api.onrender.com/health

The evaluator can open the frontend directly and test:

1. Sign up
2. Create a job
3. Run the job
4. View execution history
5. Inspect successful execution details
6. Create a failing HTTP job
7. Observe retry attempts
8. View the final failure state

No local setup is required to evaluate the deployed application.

---

# Repository structure

```text
enrichly-job-automation/
│
├── backend/
│   ├── src/
│   ├── tests/
│   ├── migrations/
│   ├── Dockerfile
│   ├── package.json
│   └── .env.example
│
├── frontend/
│   ├── src/
│   ├── Dockerfile
│   ├── package.json
│   └── .env.example
│
├── docker-compose.yml
├── API.md
├── ENGINEERING.md
├── README.md
└── .gitignore
```

---

# GitHub

Repository:

https://github.com/VarunKumar123456/enrichly-job-automation

The repository contains:

* Source code
* Tests
* Database migrations
* API documentation
* Engineering documentation
* Local development instructions
* Docker configuration
* Environment examples

---

# Engineering documentation

See [`ENGINEERING.md`](./ENGINEERING.md) for:

* Architecture
* Execution flow
* State transitions
* Concurrency
* Single-inflight execution
* Idempotency
* Optimistic locking
* Retries
* Worker failure recovery
* Scheduler correctness
* Database decisions
* Product decisions
* Testing strategy
* Known limitations
* Future improvements
* Engineering trade-offs

---

# Assignment scope

This project was intentionally scoped around the core problem described in the Enrichly assignment:

> Create and manage automated jobs, execute them, inspect execution history, and understand failures.

The implementation prioritizes:

1. Problem solving
2. Architecture
3. Correctness
4. Reliability
5. Testing
6. UX

rather than adding a large number of partially implemented features.

---

# Known limitations

The current implementation intentionally does not include:

* WebSocket/SSE real-time updates
* A pluggable multi-job-type execution framework
* API rate limiting
* A dedicated worker heartbeat
* A full production-grade distributed queue

These are documented in `ENGINEERING.md` together with the trade-offs behind the current implementation.

---

# Submission

**Live application:**
https://enrichly-frontend.onrender.com

**GitHub repository:**
https://github.com/VarunKumar123456/enrichly-job-automation

**Engineering documentation:**
[`ENGINEERING.md`](./ENGINEERING.md)
