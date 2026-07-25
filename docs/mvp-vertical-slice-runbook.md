# MVP Vertical Slice — Manual End-to-End Verification Runbook

This is Work Unit 9 of the `mvp-vertical-slice` change. It is **intentionally
not automated**: it requires a real `ANTHROPIC_API_KEY`, which does not exist
in the CI/dev sandbox this change was implemented in. Every command below has
been run manually against this repository's actual current code (routes,
scripts, ports) as part of implementing this runbook — except the very last
step, which needs a real key and must be run by a human with one.

Everything up to and including "trigger a review run" is fully testable
**without** a real key: a missing/invalid `ANTHROPIC_API_KEY` produces a real,
non-fabricated `failed` review run with a clear `error_summary` — that failure
path is exactly how the wiring was proven correct during implementation, and
it is a legitimate way to confirm the plumbing works even before you have a
key.

## 0. Prerequisites

- Docker (for Postgres+pgvector).
- Node.js 22+ and `pnpm` (already used by this repo's own `pnpm test`).
- Python 3.11+ with the worker's dependencies installed:

  ```bash
  cd services/worker
  pip3 install --break-system-packages --user \
    "fastapi>=0.115" "uvicorn>=0.30" "python-multipart>=0.0.9" \
    "pypdf>=5.0" "python-docx>=1.1" "anthropic>=0.40" "httpx>=0.27"
  ```

  (Adjust for your platform's Python if `--break-system-packages` is not
  needed/available — e.g. inside a venv, drop that flag.)

## 1. Create `.env` (manual — tooling cannot write this file)

At the repo root, create a file named `.env` with:

```
DATABASE_URL=postgres://pg1:pg1@localhost:5432/pg1
ANTHROPIC_API_KEY=sk-ant-your-real-key-here
WORKER_BASE_URL=http://localhost:8000
```

**Important — nothing in this codebase auto-loads `.env` files** (no
`dotenv` dependency is wired into either the Node API or the Python worker).
Before starting the API or the worker in the steps below, load these
variables into your shell session:

```bash
set -a
source .env
set +a
```

Do this once per terminal/session before step 3 and step 4. (`DATABASE_URL`'s
host/port/credentials already match `infra/docker-compose.yml`'s `db` service
exactly — `pg1`/`pg1`/`localhost:5432`/`pg1`. If a local Postgres is already
listening on `5432` on your machine, see the "Known local-port conflict" note
at the bottom before continuing.)

## 2. Start Postgres and run the migration

```bash
docker compose -f infra/docker-compose.yml up -d
# wait for it to report healthy:
docker compose -f infra/docker-compose.yml ps

DATABASE_URL=postgres://pg1:pg1@localhost:5432/pg1 node apps/api/src/db/migrate.mjs up
```

Verified this session: the container reaches `healthy` and `migrate.mjs up`
creates all 12 tables + the `vector` extension.

## 3. Start the worker (FastAPI)

In a new terminal, with `.env` sourced (step 1):

```bash
cd services/worker
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Confirm it's up: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/docs`
should print `200`.

## 4. Start the API (NestJS)

In a new terminal, with `.env` sourced (step 1):

```bash
cd apps/api
node --import tsx src/main.ts
```

It binds to `127.0.0.1:3000` only (never `0.0.0.0`). Confirm:
`curl -s http://127.0.0.1:3000/api/v1/thesis-documents` should return
`{"items":[],...}`.

## 5. Start the web app (Angular)

In a new terminal:

```bash
cd apps/web
pnpm start --port 4300 --host 127.0.0.1
```

The `start` script now runs `ng serve --proxy-config proxy.conf.json`, which
forwards `/api/*` requests from the dev server (port 4300) to the real API
(port 3000) — this was a genuine gap found and fixed while writing this
runbook (previously the Angular app's relative `/api/v1/...` calls had no
dev-server proxy and would 404 against `ng serve`'s own port). Verified this
session: `curl http://127.0.0.1:4300/api/v1/thesis-documents` through the dev
server returns the real API's response, not a 404.

## 6. Upload a real document and trigger a review run

Open `http://127.0.0.1:4300/upload` in a browser. Select one real `.pdf` or
`.docx` file and submit. The page will:

1. `POST /api/v1/thesis-documents` (multipart) — real bytes are written to
   disk and a real `thesis_document` row is inserted into Postgres.
2. `POST /api/v1/thesis-documents/{id}/review-runs` — this now runs the
   **real, synchronous** pipeline for a genuinely uploaded document: real
   extraction via the worker's `/internal/extract`, a real call to the
   worker's `/internal/review` (Claude), and real persistence of any finding.
   The request does not return until the run reaches `completed` or `failed`.
3. Navigate to `/runs/{runId}`, which polls `GET /api/v1/review-runs/{id}`
   every 3 seconds while the run is non-terminal, and once it is
   `completed`, reads `GET /api/v1/review-runs/{id}/findings`.

### Without a real `ANTHROPIC_API_KEY` (testable today, no key needed)

If `ANTHROPIC_API_KEY` in `.env` is missing or a placeholder, the review run
will reach **`failed`** with an `error_summary` starting with
`review failed: Worker /internal/review failed with status 500: ...
configuration_error: ANTHROPIC_API_KEY is not set...`. This was verified live
this session (real HTTP, real worker, real Postgres, only the key missing) —
it proves every hop of the wiring (upload → storage → DB → extraction →
worker call → failure handling → persisted `error_summary` → results page)
is real, not a fabrication, without needing a real key.

### With a real `ANTHROPIC_API_KEY` (the actual final acceptance step — needs a human with a key)

With a real key in `.env` (sourced before starting the worker in step 3),
repeat step 6. Expect one of:

- **A grounded finding**: the review run reaches `completed`, and the results
  page shows the finding's title, explanation, and evidence text — sourced
  live from `GET /api/v1/review-runs/{id}/findings`, not a fixture.
- **No grounded issue**: the review run reaches `completed` with zero
  findings, and the results page shows "No findings." — also a valid,
  non-error outcome per spec.

Either outcome confirms the full vertical slice end to end. This exact
sub-step is the one part of this runbook that could not be executed in this
implementation session (no real key in this environment).

## 7. Tear down

```bash
docker compose -f infra/docker-compose.yml down -v
```

Stop the `uvicorn`, `node --import tsx src/main.ts`, and `ng serve` processes
(Ctrl-C in each terminal).

## Known local-port conflict (machine-specific, not a defect)

If you see `role "pg1" does not exist` even though
`docker compose ps` shows the `db` container healthy, you likely have a
local Postgres already bound to `127.0.0.1:5432` (e.g. a Homebrew
`postgresql@17` service) intercepting connections ahead of Docker's own
port-forward. Either stop your local Postgres for the duration of this
runbook, or remap the port locally (change `5432:5432` to e.g. `5433:5432`
in `infra/docker-compose.yml` and update `DATABASE_URL`'s port to match) —
do not change the committed port mapping as a "fix"; this is purely a local
environment quirk, documented consistently since earlier PRs in this change.
