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

---

# LLM Provider Admin — Manual End-to-End Verification (`llm-provider-admin`, Work Unit 9)

This section extends the runbook above with the `llm-provider-admin` change:
DB-backed, admin-switchable LLM provider credentials (Claude/DeepSeek/Groq),
replacing the process-wide `ANTHROPIC_API_KEY`-only flow. It is **also
intentionally not automatable** for the same reason as above — the final
acceptance step needs a real `ANTHROPIC_API_KEY`, entered through the admin
UI (never `.env`, never baked into the worker's environment for this
specific verification). Everything up to and including "trigger a review
run with zero/fake providers" was run for real during this implementation
pass, against this repository's actual current code — only the very last
sub-step (a genuine Claude-produced finding) needs a human with a real key.

Extends steps 0–5 above (prerequisites, Postgres, worker, API, web) exactly
as written, plus:

## 1. Set the two new required environment variables

Add to `.env` (see step 1 above) alongside `DATABASE_URL`/`ANTHROPIC_API_KEY`/`WORKER_BASE_URL`:

```
LLM_PROVIDER_ENCRYPTION_KEY=<64 hex characters — 32 bytes, e.g. `openssl rand -hex 32`>
ADMIN_SHARED_SECRET=<any non-empty string — this is a TEMPORARY MVP gate, NOT real auth>
```

`LLM_PROVIDER_ENCRYPTION_KEY` is validated fail-fast: the admin API's first
request of any kind (including a bare `list`) returns `500
configuration_error` if it's missing or not exactly 64 hex characters —
verified this session by starting the API with the variable unset and
confirming exactly that response, with no key ever named in the error body.

## 2. Run the new migrations

`migrate.mjs` now auto-discovers every `*.sql` file under
`apps/api/src/db/migrations/` (no longer a single hardcoded path) — the same
`node apps/api/src/db/migrate.mjs up` command from step 2 above now also
applies `0002_llm_provider_config.sql` (the provider registry table) and
`0003_review_run_provider_provenance.sql` (`llm_provider_name`/`llm_model_id`
columns on `review_run`). Verified this session via `psql \dt` inside the
container: 13 tables total (12 baseline + `llm_provider_config`), and `\d
review_run` showing both new nullable columns with the expected CHECK
constraint.

## 3. Open the admin page and add a provider

With the worker (step 3), API (step 4, `ADMIN_SHARED_SECRET`/
`LLM_PROVIDER_ENCRYPTION_KEY` sourced), and web app (step 5) all running,
open `http://127.0.0.1:4300/admin/llm-providers`.

The first admin action (loading the list) triggers a browser `prompt()` for
the admin shared secret — enter the same value as `ADMIN_SHARED_SECRET`.
This is held in an in-memory signal for the rest of the browser session only
(never `localStorage`, never baked into the bundle — verified this session
via `apps/web/tests/smoke.test.mjs`'s explicit assertion that
`admin-secret-store.ts` never calls `localStorage`/`sessionStorage`, and by
inspection that a page refresh loses it and re-prompts).

Fill in the "Add provider" form:

- Provider: `claude`
- Model id: `claude-sonnet-4-20250514` (or another real Claude model id)
- API key: your real `ANTHROPIC_API_KEY`

Submit. The new row appears in the list with a masked key
(`••••<last four characters>`) — the raw key is never shown again, and the
form's API key field is cleared immediately after a successful save.
Click **Activate** on the row; its status flips to `active`.

Verified this session end to end with a FAKE key (`sk-ant-...-fake-key`):
create → `201` masked response; activate → `200`, `is_active: true`; the
real running Anthropic API genuinely rejected the fake key with `401
invalid x-api-key` when a review run was triggered afterward (see step 5
below) — proving the admin CRUD, encryption-at-rest, and the "forward the
DB-active provider's real key to the worker" wiring are all real, not
simulated, without needing a valid key for this part.

## 4. Zero active providers still fails explicitly (testable today, no key needed)

Before activating anything (or after deactivating every row — there is no
"deactivate" button in this MVP; delete the row via `PATCH`/re-create to
test this, or simply test it first before adding any row), trigger a review
run. It reaches **`failed`** with an `error_summary` matching `/no active
LLM provider configured/i` — verified live this session via the automated
`active-provider-resolution.test.mjs` integration test (and equivalently by
the pre-existing worker-unreachable failure path, which was also
re-confirmed live this session with the worker actually running: a run
against a document whose extraction failed still reached a real `failed`
status with a real, non-fabricated `error_summary`, never a silent
`completed`).

## 5. Trigger a review run and confirm provenance

Upload a real `.pdf`/`.docx` thesis (step 6 above) and trigger a review run,
exactly as before. Once the run reaches `completed`, the results page
(`/runs/{runId}`) now additionally shows **"Reviewed by: `<provider>
(<model id>)`"** above the finding list/"No findings" message — e.g.
"Reviewed by: claude (claude-sonnet-4-20250514)". This is read from the same
`GET /api/v1/review-runs/{id}` response's new `llm_provider_name`/
`llm_model_id` fields, populated on the `review_run` row at completion time
by the exact provider that produced the result — not a static label.

Runs completed **before** this change (or any other run whose provenance
columns are still `NULL`) render **"Reviewed by: Unknown provider"** — a
graceful fallback, never an error. Verified live this session by directly
nulling a genuinely-completed run's provenance columns and re-fetching its
status: `200`, `llm_provider_name: null`, `llm_model_id: null`, no crash.

### With a real `ANTHROPIC_API_KEY` (the actual final acceptance step — needs a human with a key)

With a real Claude key entered through the admin UI (step 3) and that row
activated, repeat step 5 above. Expect one of:

- **A grounded finding**: the run reaches `completed`; the results page
  shows the finding's title/explanation/evidence AND "Reviewed by: claude
  (`<model id>`)" — both sourced live from the real API, not fixtures.
- **No grounded issue**: `completed` with zero findings; the results page
  shows "No findings." and still names the provider that made that
  (real, non-fabricated) determination.

Either outcome confirms the full vertical slice, including provider
provenance, end to end. This exact sub-step is the one part of this section
that could not be executed in this implementation session (no real key in
this environment).

## Known local quirk: `localhost:8000` may resolve to the wrong process (machine-specific, not a defect)

Discovered and worked around during this session's manual verification: if
`WORKER_BASE_URL` is left unset, the API defaults to
`http://localhost:8000`. On a machine where some OTHER local process (e.g.
an unrelated `php -S`/PHP built-in dev server) is already listening on
`[::1]:8000` (IPv6 loopback) while the worker binds only to `127.0.0.1:8000`
(IPv4), Node's `fetch("http://localhost:8000/...")` can resolve `localhost`
to `::1` first and silently hit the WRONG process, returning an HTML error
page. This surfaces as a review run reaching `failed` with `error_summary:
"review failed: Unexpected token '<'... is not valid JSON"` even though the
real worker is healthy and reachable — the worker's own log will show ZERO
incoming requests in this case, which is the tell.

This is the exact same class of issue as the documented `5432` Postgres
port conflict above — a pre-existing, project-unrelated local service
squatting on a port this stack also defaults to — not a defect in this
change. Workaround: set `WORKER_BASE_URL=http://127.0.0.1:8000` explicitly
(pin the IPv4 loopback address) instead of relying on the `localhost`
default. Confirmed this session: after pinning `WORKER_BASE_URL` to
`127.0.0.1`, extraction and review requests correctly reached the real
worker (visible in its own log) and the false "not valid JSON" failure
disappeared.
