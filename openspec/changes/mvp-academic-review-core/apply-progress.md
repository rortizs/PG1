# Apply Progress — MVP Academic Review Core

## Workload / PR Boundary

- Completed slice: **PR 1 — Scaffold and tests** / Work Unit 1 only.
- Completed slice: **PR 2 — API contract and DB schema** / Work Unit 2.
- Completed slice: **PR 2 — API contract and DB schema** / Work Unit 3.
- Completed slice: **PR 3 — Upload, storage, and review lifecycle** / Work Unit 4.
- Current slice: **PR 3 — Upload, storage, and review lifecycle** / Work Unit 5 only in this pass.
- Review budget: 400 changed lines target.
- Chained strategy: stacked-to-main per `tasks.md` forecast.
- Scope guard: Work Unit 5 adds only framework-light review-run lifecycle and BullMQ-compatible queue abstraction stubs; no actual Redis/BullMQ server, DB connection, worker execution, parsing, RAG, or report generation implementation.

## Completed Tasks

- [x] Work Unit 1 RED: added failing smoke tests for API, web, and worker scaffold targets.
- [x] Work Unit 1 GREEN: added lightweight monorepo scaffold for `apps/api`, `apps/web`, `services/worker`, `infra`, and `docs`.
- [x] Work Unit 1 TRIANGULATE: added root verification command `pnpm test` that runs all component smoke tests.
- [x] Work Unit 1 REFACTOR: updated `openspec/config.yaml` test runner from placeholder `pytest -q` to `pnpm test`.
- [x] Work Unit 2 RED: added API contract tests for required `/api/v1` routes, standard error shape, pagination/filter cases, and OpenAPI baseline documentation.
- [x] Work Unit 2 GREEN: added lightweight contract-valid API stubs under `apps/api/src/` with standard `{ error, message, details, request_id, timestamp }` errors.
- [x] Work Unit 2 TRIANGULATE: covered bounded document/finding list pagination and filters.
- [x] Work Unit 2 REFACTOR: documented OpenAPI at `docs/api/openapi.yaml`.
- [x] Work Unit 2 REVIEW FIX: added regression coverage for OpenAPI server/path prefix duplication and set server URL to `/`.
- [x] Work Unit 2 REVIEW FIX: added NestJS-compatible controller/module seams for thesis document and review-run route ownership without adding framework dependencies.
- [x] Work Unit 3 RED: added static migration/schema tests for required tables, pgvector setup, constraints, status checks, FK indexes, `timestamptz`, `snake_case`, normalized relations, constrained `jsonb`, non-empty evidence, and down migration structure.
- [x] Work Unit 3 GREEN: added PostgreSQL baseline SQL migration under `apps/api/src/db/migrations/` for all required core tables.
- [x] Work Unit 3 TRIANGULATE: added explicit FK indexes, composite access-path indexes, pgvector extension setup, and status/evidence/location constraints.
- [x] Work Unit 3 REFACTOR: kept optional/semi-structured fields in `metadata jsonb` columns constrained to JSON objects.
- [x] Work Unit 3 REVIEW FIX: added regression coverage and FK from `embedding_record.source_id` to `normative_segment(id)`.
- [x] Work Unit 3 REVIEW FIX: added `DROP EXTENSION IF EXISTS vector` to the down migration to restore an empty DB state for this baseline.
- [x] Work Unit 4 RED: added upload/storage tests for PDF/DOCX acceptance, unsupported type rejection, exactly-one-file validation, no review run on rejection, SHA-256 metadata, deterministic storage keys, and API contract delegation.
- [x] Work Unit 4 GREEN: added framework-light upload service and memory-local object storage abstraction under `apps/api/src/thesis-documents/` and `apps/api/src/storage/`.
- [x] Work Unit 4 TRIANGULATE: upload responses now expose thesis_document-style metadata including filename, content type, size, storage key, SHA-256, uploader, upload status, review eligibility, and storage provider.
- [x] Work Unit 4 REFACTOR: isolated storage key construction and memory-local adapter behind an explicit object storage interface compatible with local/S3-style object keys.
- [x] Work Unit 4 REVIEW FIX: rejected empty uploads and declared-size mismatches without writing storage or creating review runs.
- [x] Work Unit 4 REVIEW FIX: hardened storage key filename fallback when slugging removes all characters.
- [x] Work Unit 5 RED: added review-run lifecycle tests for allowed statuses, creation returning `202`, extraction job enqueue, idempotency, status transitions, cancellation, failure summary, and audit events.
- [x] Work Unit 5 GREEN: added framework-light review-run lifecycle service and BullMQ-compatible in-memory queue adapter under `apps/api/src/review-runs/` and `apps/api/src/jobs/`.
- [x] Work Unit 5 TRIANGULATE: added idempotency key format `review_run:{id}:{stage}:{pipeline_version}`, audit events for lifecycle changes, and duplicate-start protection.
- [x] Work Unit 5 REFACTOR: centralized allowed statuses exactly in `ALLOWED_REVIEW_RUN_STATUSES`.
- [x] Work Unit 5 REVIEW FIX: prevented same-document/different-pipeline starts from corrupting idempotency results by assigning distinct run IDs per pipeline version.
- [x] Work Unit 5 REVIEW FIX: added collision regression for pipeline versions that normalize similarly and switched later run IDs to per-document sequence IDs.
- [x] Work Unit 5 REVIEW FIX: added cross-document run ID collision regression and made generated run IDs globally unique within the lifecycle service.
- [x] Work Unit 5 REVIEW FIX: made job failure respect terminal lifecycle rules so completed/cancelled runs cannot be mutated to failed by late worker errors.
- [x] Work Unit 5 REVIEW FIX: routed API contract review-run creation through the lifecycle service instead of the legacy contract stub.

## Files Changed

- `.gitignore`
- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `scripts/run-smoke-tests.mjs`
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/src/main.ts`
- `apps/api/src/api-contract.mjs`
- `apps/api/src/db/migrations/0001_schema_baseline.sql`
- `apps/api/src/storage/object-storage.mjs`
- `apps/api/src/thesis-documents/upload-service.mjs`
- `apps/api/src/jobs/review-queue.mjs`
- `apps/api/src/review-runs/review-run-lifecycle.mjs`
- `apps/api/tests/smoke.test.mjs`
- `apps/api/tests/contract.test.mjs`
- `apps/api/tests/schema-migration.test.mjs`
- `apps/api/tests/upload-storage.test.mjs`
- `apps/api/tests/review-run-lifecycle.test.mjs`
- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `apps/web/src/app/app.ts`
- `apps/web/src/app/routes.ts`
- `apps/web/src/app/features/review-dashboard/review-dashboard.ts`
- `apps/web/tests/smoke.test.mjs`
- `services/worker/package.json`
- `services/worker/pyproject.toml`
- `services/worker/app/__init__.py`
- `services/worker/app/main.py`
- `services/worker/tests/test_smoke.py`
- `infra/README.md`
- `docs/testing.md`
- `docs/api/openapi.yaml`
- `openspec/config.yaml`
- `openspec/changes/mvp-academic-review-core/tasks.md`
- `openspec/changes/mvp-academic-review-core/apply-progress.md`

## Test Commands Run

| Phase | Command | Result |
| --- | --- | --- |
| RED | `pnpm test` | Failed as expected because `apps/api/src/main.ts` did not exist. |
| GREEN | `pnpm test` | Passed API, web, and worker smoke tests. |
| Work Unit 2 RED | `pnpm test` | Failed as expected with `ERR_MODULE_NOT_FOUND` for missing `apps/api/src/api-contract.mjs`. |
| Work Unit 2 GREEN | `pnpm test` | Passed 11 API tests, 1 web smoke test, and 1 worker unittest. |
| Work Unit 2 review RED | `pnpm --dir apps/api test` | Failed as expected because OpenAPI used `servers: /api/v1` while paths also included `/api/v1`. |
| Work Unit 2 review GREEN | `pnpm test` | Passed 12 API tests, 1 web smoke test, and 1 worker unittest. |
| Work Unit 2 controller seam RED | `pnpm --dir apps/api test` | Failed as expected with `ENOENT` for missing `apps/api/src/app.module.ts`. |
| Work Unit 2 final GREEN | `pnpm test` | Passed 13 API tests, 1 web smoke test, and 1 worker unittest. |
| Work Unit 3 RED | `pnpm --dir apps/api test` | Failed as expected with `ENOENT` for missing `apps/api/src/db/migrations/0001_schema_baseline.sql`. |
| Work Unit 3 GREEN | `pnpm --dir apps/api test` | Passed 18 API/schema tests. |
| Work Unit 3 final verification | `pnpm test` | Passed 18 API/schema tests, 1 web smoke test, and 1 worker unittest. |
| Work Unit 3 review RED | `pnpm --dir apps/api test` | Failed as expected because `embedding_record.source_id` lacked a FK to `normative_segment(id)` and down migration lacked `DROP EXTENSION IF EXISTS vector`. |
| Work Unit 3 review GREEN | `pnpm test` | Passed 19 API/schema tests, 1 web smoke test, and 1 worker unittest. |
| Work Unit 4 RED | `pnpm --dir apps/api test` | Failed as expected with `ERR_MODULE_NOT_FOUND` for missing `apps/api/src/storage/object-storage.mjs`. |
| Work Unit 4 GREEN | `pnpm --dir apps/api test` | Passed 24 API/schema/upload tests. |
| Work Unit 4 final verification | `pnpm test` | Passed 24 API/schema/upload tests, 1 web smoke test, and 1 worker unittest. |
| Work Unit 4 review RED | `pnpm --dir apps/api test` | Failed as expected for empty upload acceptance, declared size mismatch acceptance, and missing filename fallback test helper. |
| Work Unit 4 review GREEN | `pnpm test` | Passed 27 API/schema/upload tests, 1 web smoke test, and 1 worker unittest. |
| Work Unit 5 RED | `pnpm --dir apps/api test` | Failed as expected with `ERR_MODULE_NOT_FOUND` for missing `apps/api/src/review-runs/review-run-lifecycle.mjs`. |
| Work Unit 5 GREEN | `pnpm --dir apps/api test` | Passed 33 API/schema/upload/lifecycle tests. |
| Work Unit 5 final verification | `pnpm test` | Passed 33 API/schema/upload/lifecycle tests, 1 web smoke test, and 1 worker unittest. |
| Work Unit 5 review RED | `pnpm --dir apps/api test` | Failed as expected for API route still using legacy stub, same-document/different-pipeline run ID collision, and late job failure mutating terminal runs. |
| Work Unit 5 review GREEN | `pnpm test` | Passed 35 API/schema/upload/lifecycle tests, 1 web smoke test, and 1 worker unittest. |
| Work Unit 5 collision RED | `pnpm --dir apps/api test` | Failed as expected when pipeline versions `v2` and `v2!` produced the same run ID and corrupted idempotency results. |
| Work Unit 5 final GREEN | `pnpm test` | Passed 36 API/schema/upload/lifecycle tests, 1 web smoke test, and 1 worker unittest. |
| Work Unit 5 global collision RED | `pnpm --dir apps/api test` | Failed as expected when `doc_collision_2/v1` collided with second pipeline run ID for `doc_collision/v2`. |
| Work Unit 5 final GREEN after global collision fix | `pnpm test` | Passed 37 API/schema/upload/lifecycle tests, 1 web smoke test, and 1 worker unittest. |

## TDD Cycle Evidence

| Cycle | RED test | RED evidence | GREEN implementation | GREEN evidence | Refactor/Triangulation |
| --- | --- | --- | --- | --- | --- |
| Work Unit 1 scaffold | API/web/worker smoke tests assert expected scaffold entrypoints exist. | `pnpm test` failed with `ENOENT ... apps/api/src/main.ts`. | Added minimal API, web, worker scaffold files and root/component test commands. | `pnpm test` passed 1 API test, 1 web test, and 1 worker unittest. | Root command now executes component tests via `scripts/run-smoke-tests.mjs`; `openspec/config.yaml` uses `pnpm test`. |
| Work Unit 2 API contract | API contract tests assert required versioned routes, resource nouns, standard errors, pagination/filter cases, and OpenAPI docs. | `pnpm test` failed with `ERR_MODULE_NOT_FOUND` for missing `apps/api/src/api-contract.mjs`. | Added `handleApiRequest` and `listApiRoutes` contract stubs plus `docs/api/openapi.yaml`. | `pnpm test` passed 11 API tests, 1 web smoke test, and 1 worker unittest. | Kept implementation framework-light; no DB/upload/queue/auth/RAG/report generation added. |
| Work Unit 3 PostgreSQL schema | Static migration tests assert required tables, `pgvector`, identity PKs, `timestamptz`, status checks, non-empty evidence, JSONB object constraints, normalized FKs, FK indexes, and down migration drops. | `pnpm --dir apps/api test` failed with `ENOENT ... 0001_schema_baseline.sql`. | Added `apps/api/src/db/migrations/0001_schema_baseline.sql` with 12 required tables and indexes. | `pnpm --dir apps/api test` passed 18 tests. | Used static SQL tests because no live PostgreSQL service is required/available for this slice; no DB connection or ORM setup was introduced. |
| Work Unit 4 upload/storage | Upload tests assert PDF/DOCX acceptance, unsupported type rejection, exactly-one-file validation, no review run on rejection, SHA-256 metadata, deterministic storage keys, and API contract delegation. | `pnpm --dir apps/api test` failed with `ERR_MODULE_NOT_FOUND ... storage/object-storage.mjs`. | Added `processThesisDocumentUpload`, `createMemoryObjectStorage`, deterministic key builder, and API contract delegation when file input is provided. | `pnpm --dir apps/api test` passed 24 tests. | Kept implementation framework-light; no multipart server, DB writes, or real S3 client introduced. |
| Work Unit 5 review-run lifecycle | Lifecycle tests assert exact allowed statuses, `202` start response, extraction job enqueue, idempotency, transition validation, cancellation, failure summary, and audit events. | `pnpm --dir apps/api test` failed with `ERR_MODULE_NOT_FOUND ... review-run-lifecycle.mjs`. | Added `createReviewRunLifecycleService`, centralized `ALLOWED_REVIEW_RUN_STATUSES`, idempotency key builder, and `createMemoryReviewQueue`. | `pnpm --dir apps/api test` passed 33 tests. | Kept implementation framework-light; no Redis/BullMQ dependency, DB writes, worker calls, parsing, RAG, or reports introduced. |

## Deviations From Design

- Used lightweight hand-authored scaffold rather than framework generators to protect review budget.
- Worker smoke test uses Python standard-library `unittest` because `pytest` was not installed in the environment; `pyproject.toml` leaves room for future pytest configuration.
- API and web smoke tests use Node's built-in test runner and file-level scaffold assertions; real NestJS/Angular dependencies are deferred to later slices.
- Work Unit 2 uses a framework-light contract module (`api-contract.mjs`) rather than real NestJS controllers to stay inside the assigned API contract slice and avoid framework generator churn.
- Work Unit 3 uses static SQL migration tests rather than a live PostgreSQL execution harness; this follows the slice constraint allowing static migration tests when PostgreSQL is unavailable.
- Work Unit 4 persists thesis-document-style metadata in a framework-light upload response and object storage stub, not a live PostgreSQL row; real DB persistence remains for later API/DB integration slices.
- Work Unit 5 uses a BullMQ-compatible in-memory queue adapter/test double instead of real Redis/BullMQ to protect review budget and avoid external service requirements.

## Remaining Tasks

- Work Unit 6: worker extraction contract.
- Work Unit 7+: page/section persistence, evidence validation, rules, controlled RAG, reports, and agentic scaffold remain untouched.

## Verification Evidence

- Work Unit 1 final verification command: `pnpm test`
- Work Unit 1 result: passed API smoke test, web smoke test, and worker unittest.
- Work Unit 2 final verification command: `pnpm test`
- Work Unit 2 result: passed 11 API tests, 1 web smoke test, and 1 worker unittest.
- Work Unit 2 review fix verification command: `pnpm test`
- Work Unit 2 review fix result: passed 12 API tests, 1 web smoke test, and 1 worker unittest.
- Work Unit 2 final verification command: `pnpm test`
- Work Unit 2 final result: passed 13 API tests, 1 web smoke test, and 1 worker unittest.
- Work Unit 3 API-focused verification command: `pnpm --dir apps/api test`
- Work Unit 3 API-focused result: passed 18 API/schema tests.
- Work Unit 3 final verification command: `pnpm test`
- Work Unit 3 final result: passed 18 API/schema tests, 1 web smoke test, and 1 worker unittest.
- Work Unit 3 review fix verification command: `pnpm test`
- Work Unit 3 review fix result: passed 19 API/schema tests, 1 web smoke test, and 1 worker unittest.
- Work Unit 4 API-focused verification command: `pnpm --dir apps/api test`
- Work Unit 4 API-focused result: passed 24 API/schema/upload tests.
- Work Unit 4 final verification command: `pnpm test`
- Work Unit 4 final result: passed 24 API/schema/upload tests, 1 web smoke test, and 1 worker unittest.
- Work Unit 4 review fix verification command: `pnpm test`
- Work Unit 4 review fix result: passed 27 API/schema/upload tests, 1 web smoke test, and 1 worker unittest.
- Work Unit 5 API-focused verification command: `pnpm --dir apps/api test`
- Work Unit 5 API-focused result: passed 33 API/schema/upload/lifecycle tests.
- Work Unit 5 final verification command: `pnpm test`
- Work Unit 5 final result: passed 33 API/schema/upload/lifecycle tests, 1 web smoke test, and 1 worker unittest.
- Work Unit 5 review fix verification command: `pnpm test`
- Work Unit 5 review fix result: passed 35 API/schema/upload/lifecycle tests, 1 web smoke test, and 1 worker unittest.
- Work Unit 5 final verification command: `pnpm test`
- Work Unit 5 final result: passed 36 API/schema/upload/lifecycle tests, 1 web smoke test, and 1 worker unittest.
- Work Unit 5 global collision fix verification command: `pnpm test`
- Work Unit 5 global collision fix result: passed 37 API/schema/upload/lifecycle tests, 1 web smoke test, and 1 worker unittest.
