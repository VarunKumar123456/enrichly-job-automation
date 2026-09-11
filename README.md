# Job Automation Platform

A web app for creating, running, and monitoring automated jobs (scheduled
or manually triggered HTTP calls / webhooks), built for the Enrichly
Full Stack Developer Intern assignment.

Architecture, concurrency design, and trade-offs are documented in
[`ENGINEERING.md`](./ENGINEERING.md).

## Stack

- **Frontend**: Next.js 14 (App Router) + React + TypeScript + Tailwind
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL (raw SQL via `pg`, no ORM — see ENGINEERING.md
  for why, particularly around the concurrency-critical queries)
- **Worker**: a separate Node process polling Postgres for due work

> The brief's preferred backend was .NET/C#. I used Node instead — see
> "Stack deviation" in ENGINEERING.md for the honest reason and how the
> design maps to .NET.

## Running locally (Docker — recommended)

Requires Docker + Docker Compose.

```bash
git clone <your-repo-url>
cd enrichly-job-automation
docker compose up --build
```

This starts Postgres, runs migrations, then starts the API (port 4000),
one worker, and the frontend (port 3000).

Open **http://localhost:3000**, sign up with any email/password (8+ chars),
create a job, and click "Run now."

To prove the concurrency guarantee yourself, scale up workers:

```bash
docker compose up --build --scale worker=3
```

## Running locally (without Docker)

You'll need Postgres 14+ running locally.

**1. Database**
```bash
createdb enrichly
cd backend
cp .env.example .env
# edit .env: set DATABASE_URL to your local Postgres connection string
npm install
npm run migrate
```

**2. Backend API** (in `backend/`)
```bash
npm run dev
# API on http://localhost:4000
```

**3. Worker** (in a second terminal, also in `backend/`)
```bash
npm run worker:dev
```

**4. Frontend** (in a third terminal, in `frontend/`)
```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
# App on http://localhost:3000
```

## Running tests

```bash
cd backend
npm install
# point at any reachable Postgres — tests create/drop their own rows,
# they do not require an empty database, but do not point this at
# production data:
export DATABASE_URL=postgresql://user:pass@localhost:5432/enrichly_test
export JWT_SECRET=test-secret
npm test
```

21 tests across 3 suites:
- `tests/retryPolicy.test.ts` — pure unit tests, no DB required.
- `tests/concurrency.integration.test.ts` — proves the `SKIP LOCKED` claim
  logic against a **real** Postgres instance (not mocked).
- `tests/api.integration.test.ts` — end-to-end tests against the real
  Express app: auth, optimistic locking conflicts, idempotency, retries.

## Environment variables

**Backend** (`backend/.env`, see `.env.example`)

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | — (required) |
| `JWT_SECRET` | Secret for signing auth tokens | — (required in production) |
| `PORT` | API port | `4000` |
| `DB_POOL_MAX` | Max Postgres pool connections | `10` |
| `WORKER_POLL_INTERVAL_MS` | How often each worker polls for work | `2000` |
| `WORKER_BATCH_SIZE` | Max executions claimed per poll | `5` |
| `SCHEDULER_POLL_INTERVAL_MS` | How often the scheduler checks for due cron jobs | `5000` |
| `RUN_SCHEDULER_IN_API` | Run the scheduler loop inside the API process | `true` |

**Frontend** (`frontend/.env.local`, see `.env.example`)

| Variable | Description | Default |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the backend API | `http://localhost:4000` |

## Deploying (Render — free tier, ~10 minutes)

1. Push this repo to GitHub (see below).
2. On [render.com](https://render.com): **New > PostgreSQL** — create a
   free Postgres instance, copy its **Internal Database URL**.
3. **New > Web Service** (backend): connect your repo, set:
   - Root directory: `backend`
   - Build command: `npm install && npm run build && npm run migrate`
   - Start command: `npm start`
   - Env vars: `DATABASE_URL` (from step 2), `JWT_SECRET` (any long random
     string), `RUN_SCHEDULER_IN_API=true`
4. **New > Background Worker** (worker): same repo, root directory
   `backend`, build command `npm install && npm run build`, start command
   `npm run worker:start`, same `DATABASE_URL`.
5. **New > Web Service** (frontend): root directory `frontend`, build
   command `npm install && npm run build`, start command `npm start`, env
   var `NEXT_PUBLIC_API_URL` set to your backend service's Render URL from
   step 3.
6. Once all three are live, open the frontend URL — that's your submission
   link.

(Railway or Fly.io work the same way — one Postgres instance, one service
for the API, one for the worker, one for the frontend.)

## Pushing to GitHub

```bash
cd enrichly-job-automation
git init
git add .
git commit -m "Job automation platform — Enrichly take-home"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

(Create the empty repo on GitHub first via the web UI or `gh repo create`.)
