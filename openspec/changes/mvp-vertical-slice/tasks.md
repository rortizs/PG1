# Tasks: MVP Vertical Slice (Upload → CAG Review → Persist → UI)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 2,000–3,200 across compose/migration, NestJS wiring, Angular scaffold, FastAPI+Claude module, and tests |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR A (compose+migration) → PR B (NestJS+Angular scaffold) → PR C (extraction+CAG+persistence) → PR D (results view+manual e2e) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Postgres+pgvector `docker-compose.yml` + `.env.example` contract | PR A | N/A (infra only) | `docker compose up db` | delete `infra/docker-compose.yml` |
| 2 | Live migration runner for `0001` | PR A | `pnpm --dir apps/api test` | `node apps/api/src/db/migrate.mjs up` against dockerized pg | delete `migrate.mjs`, keep static migration tests |
| 3 | Real NestJS transport wrapping existing services | PR B | `pnpm --dir apps/api test` | `pnpm --dir apps/api start` + curl | revert `main.ts`/`*.controller.ts` decorators |
| 4 | Real Angular upload scaffold + smoke test rewrite | PR B | `pnpm --dir apps/web test` | `pnpm --dir apps/web start` | revert `apps/web/src` to pre-scaffold commit |
| 5 | FastAPI `/internal/extract` (pypdf/python-docx) | PR C | `pnpm --dir services/worker test` | `uvicorn` local run + curl | delete extraction route, keep stub |
| 6 | `LLMProvider` protocol + `AnthropicProvider` + fake-provider CAG tests | PR C | `pnpm --dir services/worker test` | N/A (no live key; fake provider only) | delete `providers/`, `cag_review.py` |
| 7 | Finding/evidence persistence + inline queue orchestration | PR C | `pnpm --dir apps/api test` | dockerized pg integration run | delete `review-repository.mjs`, keep lifecycle Map path |
| 8 | Angular results/status view on live API data | PR D | `pnpm --dir apps/web test` | `pnpm --dir apps/web start` against running API | revert results component |
| 9 | Manual end-to-end verification with real key | PR D | N/A — not part of `pnpm test` | user-run script with real `ANTHROPIC_API_KEY` + Docker pg | N/A, verification only |

## Scope Guard

- Redis/BullMQ stay out of scope; `inline-review-queue.mjs` preserves the `add()` seam for a later real swap — never delete `review-queue.mjs`/`review-run-lifecycle.mjs`.
- Only Claude is wired (`AnthropicProvider`); no OpenAI reintroduction.
- `.env`/`.env.example` cannot be created by tooling — every task needing it is a documented manual user step, never an auto-verified checkbox.
- No live `ANTHROPIC_API_KEY` exists yet; all CAG tests run against a fake `LLMProvider`. Work Unit 9 is the only place the real key is exercised, manually, by the user.
- Threat-matrix rows are N/A (no exec-file/VCS automation in this slice); process-integration guards (worker bound to localhost, secrets server-side only, HTTP timeouts) are apply-phase hardening, folded into Work Units 3/5/6 GREEN/REFACTOR steps, not separate RED tests.

## Work Units

### 1. Postgres+pgvector compose + env contract

- [x] RED: N/A — infra config, no test framework covers compose files.
- [x] GREEN: Create `infra/docker-compose.yml` with `pgvector/pgvector:pg16` service `db`; document `.env.example` content (`DATABASE_URL`, `ANTHROPIC_API_KEY`, `WORKER_BASE_URL`) as a **manual step for the user** — do not attempt to write `.env*` files.
- [x] TRIANGULATE: Verify `docker compose up db` exposes 5432 and extension `vector` is preinstalled.
- [x] REFACTOR: N/A.
- [x] Verify: `docker compose up db` reaches healthy state; user confirms local `.env` exists before PR B.
- [x] Rollback: `docker compose down -v`; delete `infra/docker-compose.yml`.

### 2. Live migration execution

- [x] RED: Add `apps/api/tests/migrate-runner.test.mjs` asserting `migrate.mjs up` applies `0001` against a live pg URL and `down` reverts it (skip/mark integration-tier if `DATABASE_URL` unset).
- [x] GREEN: Implement `apps/api/src/db/migrate.mjs` (`pg` client splitting `-- UP`/`-- DOWN`).
- [x] TRIANGULATE: Run against dockerized pg from Work Unit 1; confirm all 12 tables + `vector` extension created.
- [x] REFACTOR: Deferred — sharing the pg client factory with `review-repository.mjs` moves to Work Unit 7 (PR C), since that file does not exist yet in this pass.
- [x] Verify: `pnpm --dir apps/api test` green; manual `migrate.mjs up`/`down` cycle against Docker pg succeeds.
- [x] Rollback: `migrate.mjs down`; drop compose volume.

### 3. Real NestJS transport

- [x] RED: Update `apps/api/tests/contract.test.mjs`/`smoke.test.mjs` to boot the real `app.listen()` and hit routes over HTTP instead of in-memory `handleApiRequest`.
- [x] GREEN: Add `@nestjs/core|common|platform-express`; wire `main.ts`, `app.module.ts`, `*.controller.ts` with decorators delegating to existing services (no logic rewrite).
- [x] TRIANGULATE: Confirm `upload-service.mjs`, `review-run-lifecycle.mjs` signatures unchanged; 13 `contract.test.mjs` cases still pass.
- [x] REFACTOR: Bind server to `localhost` only; centralize error-shape mapping.
- [x] Verify: `pnpm --dir apps/api test` green; manual `pnpm --dir apps/api start` + curl round trip.
- [x] Rollback: revert `main.ts`/module/controller decorators to pre-Nest stub.

### 4. Angular upload scaffold

- [x] RED: Rewrite `apps/web/tests/smoke.test.mjs` to fail against the current placeholder (`Pg1AdminApp`/`features/review-dashboard`) — document this as a conscious, expected regression before scaffolding.
- [x] GREEN: Run real Angular CLI scaffold (standalone, signals, `provideHttpClient`); implement `/upload` route posting to `POST /api/v1/thesis-documents`.
- [x] TRIANGULATE: Cover valid-PDF, unsupported-type, and zero/multi-file submit scenarios per spec.
- [x] REFACTOR: Extract a typed `ThesisApiClient` service reused by Work Unit 8.
- [x] Verify: `pnpm --dir apps/web test` green on rewritten suite; other 36 repo tests stay green via `pnpm test`.
- [x] Rollback: `git revert` scaffold commit; restore prior placeholder + original smoke test.

### 5. FastAPI extraction endpoint

- [ ] RED: Add `services/worker/tests/test_extract.py` for `POST /internal/extract` with PDF/DOCX fixtures asserting page-level text + provenance.
- [ ] GREEN: Implement real `FastAPI()` app, `pypdf`/`python-docx` extraction in `services/worker/app/main.py`.
- [ ] TRIANGULATE: Cover empty/corrupt file and unsupported content-type error cases.
- [ ] REFACTOR: Isolate extraction into its own module for reuse by Work Unit 7's orchestration.
- [ ] Verify: `pnpm --dir services/worker test` green; manual `uvicorn` + curl smoke.
- [ ] Rollback: revert `main.ts` extraction route; keep worker returning a stub.

### 6. Claude CAG module behind `LLMProvider`

- [ ] RED: Add `services/worker/tests/test_cag_review.py` using a **fake `LLMProvider`** asserting: grounded excerpt → one finding with evidence; ungrounded excerpt → `null`; malformed JSON from provider → explicit error, no fabricated finding.
- [ ] GREEN: Implement `services/worker/app/providers/` protocol + `AnthropicProvider`, and `cag_review.py` building the corpus+excerpt prompt and parsing structured JSON.
- [ ] TRIANGULATE: Add missing-`ANTHROPIC_API_KEY` case returning explicit config error, never a silent `completed`.
- [ ] REFACTOR: Apply request timeout on the Claude HTTP call; keep provider swap-in-ready for DeepSeek/Groq.
- [ ] Verify: `pnpm --dir services/worker test` green against fake provider only (no live key required).
- [ ] Rollback: delete `providers/`/`cag_review.py`; `/internal/review` reverts to stub `null`.

### 7. Finding/evidence persistence + inline queue

- [ ] RED: Add `apps/api/tests/review-repository.test.mjs` (integration tier, live pg) asserting writes: `thesis_document`→`review_run`→`evidence_snippet`→`finding`→`finding_evidence`, seeded `normative_source` rows for the 4 corpus files, and rejection of candidates with zero evidence.
- [ ] GREEN: Implement `apps/api/src/db/review-repository.mjs` and `apps/api/src/jobs/inline-review-queue.mjs` (`createInlineReviewQueue({ processor })` preserving `add()`).
- [ ] TRIANGULATE: Wire orchestration: upload → extract → CAG review → persist, driven synchronously from the review-run trigger.
- [ ] REFACTOR: Keep `review-queue.mjs`/`review-run-lifecycle.mjs` untouched as the future BullMQ seam.
- [ ] Verify: `pnpm --dir apps/api test` green; manual run against Docker pg produces a persisted finding with evidence.
- [ ] Rollback: delete `review-repository.mjs`/`inline-review-queue.mjs`; lifecycle stays on in-memory Map.

### 8. Angular results/status view

- [ ] RED: Add component test for `/runs/:id` covering in-progress status, one persisted finding, and zero-finding "no findings" state per spec scenarios.
- [ ] GREEN: Implement results view reading `GET /review-runs/{id}` and `GET /review-runs/{id}/findings` via `ThesisApiClient`.
- [ ] TRIANGULATE: Cover polling/refresh while `status` is non-terminal.
- [ ] REFACTOR: Share status-badge/finding-card presentational components.
- [ ] Verify: `pnpm --dir apps/web test` green; `pnpm test` at root stays fully green (37+ tests).
- [ ] Rollback: revert results component; upload flow (Work Unit 4) unaffected.

### 9. Manual end-to-end verification

- [ ] RED: N/A — cannot be automated without a live `ANTHROPIC_API_KEY` and live Docker pg.
- [ ] GREEN: N/A — no code change; runbook only.
- [ ] TRIANGULATE: Document steps in `README.md`: user adds real key to `.env`, `docker compose up db`, `migrate.mjs up`, start api/worker/web, upload one real PDF/DOCX, trigger run, confirm finding renders.
- [ ] REFACTOR: N/A.
- [ ] Verify: user manually confirms one real finding is visible end to end; this step is explicitly excluded from automated `pnpm test`.
- [ ] Rollback: N/A — verification only, no persisted artifacts required to revert.

## Suggested PR Chain

1. **PR A — Compose + live migration**: Work Units 1–2.
2. **PR B — Real NestJS transport + Angular upload scaffold**: Work Units 3–4.
3. **PR C — Extraction + Claude CAG + persistence**: Work Units 5–7.
4. **PR D — Results view + manual e2e verification**: Work Units 8–9.
