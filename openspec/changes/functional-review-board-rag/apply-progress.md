# Apply Progress: Functional Review Board RAG — Slice 1 UI Shell

## Status

completed — completed the Slice 1 UI shell batch with Angular review-board and student-review routes over the existing pure helper layer. Backend board persistence, real vector retrieval, and PDF export remain out of scope.

## Changed files

### Previous helper batch

- `apps/web/tests/review-board-view.test.mjs` — added board-state, failed/cancelled visibility, approved override, and priority ordering tests.
- `apps/web/src/app/review-board/review-board-view.ts` — added pure board-state mapping and grouped column view model.
- `apps/web/tests/review-progress-view.test.mjs` — added deterministic lifecycle stage/percentage projection tests.
- `apps/web/src/app/review-board/review-progress-view.ts` — added projected progress view model with truthful non-vector review labeling.
- `apps/web/tests/upload-validation.test.mjs` — added 20 MB boundary coverage while preserving PDF/DOCX and count validation.
- `apps/web/src/app/upload/upload-validation.ts` — added `MAX_THESIS_FILE_SIZE_BYTES` and `file_size` rejection.
- `apps/web/tests/report-download-view.test.mjs` — added Markdown artifact selection and download metadata tests.
- `apps/web/src/app/results/report-download-view.ts` — added pure Markdown report artifact helper.

### Current UI pages batch

- `apps/web/tests/review-pages.test.mjs` — added RED tests for board/detail route registration, helper reuse, demo-data honesty, Markdown report action, and no vector-RAG claim.
- `apps/web/src/app/app.routes.ts` — registered `/review-board` and `/students/:studentId/review` routes.
- `apps/web/src/app/review-board/review-board-page.ts` — added minimal academic review-board page using `buildReviewBoardColumns` and a clearly named `SAMPLE_REVIEW_BOARD_CARDS` seam.
- `apps/web/src/app/review-board/student-review-page.ts` — added minimal student review detail shell using upload validation, progress projection, and Markdown report download helpers with clearly named sample data.
- `openspec/changes/functional-review-board-rag/tasks.md` — checked completed UI page tasks only.
- `openspec/changes/functional-review-board-rag/apply-progress.md` — recorded this batch.

## RED evidence

### Previous helper batch

- `pnpm --dir apps/web test` failed before implementation:
  - missing `apps/web/src/app/results/report-download-view.ts`;
  - missing `apps/web/src/app/review-board/review-board-view.ts`;
  - missing `apps/web/src/app/review-board/review-progress-view.ts`;
  - oversized PDF validation expected `false` but returned `true`.

### Current UI pages batch

- `pnpm --dir apps/web test -- tests/review-pages.test.mjs` failed before implementation with 51 passing tests and 3 expected failures:
  - route source did not contain `review-board`;
  - missing `apps/web/src/app/review-board/review-board-page.ts`;
  - missing `apps/web/src/app/review-board/student-review-page.ts`.

## GREEN evidence

### Previous helper batch

- `pnpm --dir apps/web test` passed after implementation: 51 tests, 51 pass, 0 fail.
- `pnpm --dir apps/web test` passed again after refactor/line-budget compaction: 51 tests, 51 pass, 0 fail.
- Parent verification reran `pnpm --dir apps/web test`: 51 tests, 51 pass, 0 fail.
- Parent verification reran `pnpm test`: API 85 tests with 71 pass / 14 skipped, web 51 pass, worker 56 pass. Worker emitted existing warning text `EOF marker not found` but unittest result was OK.
- Parent verification ran `lsp_diagnostics` on changed TypeScript helpers: 0 diagnostics.
- Parent verification ran `lens_diagnostics mode=all` on changed files/artifacts after fixing one markdown table warning: no issues.

### Current UI pages batch

- `pnpm --dir apps/web test` passed after implementation: 54 tests, 54 pass, 0 fail.
- `pnpm test` passed after implementation: API 85 tests with 71 pass / 14 skipped, web 54 pass, worker 56 pass. Worker emitted existing warning text `EOF marker not found` but unittest result was OK.
- Parent verification reran `pnpm --dir apps/web test && pnpm test`: web 54 tests passed; root API 71 pass / 14 skipped under default DB env, web 54 pass, worker 56 pass.
- Parent verification reran `DATABASE_URL=postgres://pg1:pg1@localhost:55432/pg1 pnpm --dir apps/api test`: API 85 tests passed, 0 skipped, against the local pgvector container.
- Parent verification ran `lsp_diagnostics` on changed TypeScript files: 0 diagnostics.
- `app.routes.ts` extensionless Angular imports were marked false-positive for the generic ESM extension rule because this project uses extensionless TypeScript imports consistently.

## Completed tasks

- Pure review board view-model tests and implementation.
- Pure deterministic review progress view-model tests and implementation.
- Client upload validation 20 MB max tests and implementation.
- Pure Markdown report artifact selection/download metadata tests and implementation.
- Angular review-board page/component and route using the pure board view model.
- Student review detail page/component and route using upload validation, progress projection, and report download helpers.
- Truthful review-stage/UI labeling says Rules + CAG review and does not claim real vector RAG.
- Targeted web tests and root `pnpm test` were run.

## Incomplete tasks

- Backend board persistence remains out of scope for Slice 1 and was not implemented.
- Real vector RAG remains out of scope and was not implemented.
- PDF export remains out of scope and was not implemented.
- The BDD checkpoint for under-20 MB upload starting a persisted review and moving a real card to `In Review` remains dependent on backend board persistence/API integration.

## Risks

- The new board/detail pages use clearly labeled local sample data because durable board API persistence is not ready.
- The test suite verifies page registration and helper reuse via source-level tests; no Angular build/typecheck was run in this batch because the provided runner was `pnpm test`.
- Server-side 20 MB enforcement was not changed in this batch; follow-up Slice 2 already tracks backend enforcement if still missing.
- Root tests skip live Postgres-backed integration cases under the default `DATABASE_URL`, but the API suite passed with `DATABASE_URL=postgres://pg1:pg1@localhost:55432/pg1` against the local pgvector container.

## Next recommendation

Proceed to SDD verify for Slice 1, or plan Slice 2 for durable board persistence and real upload-to-board integration. Keep real vector retrieval in its separate RAG foundation slice.

---

# Apply Progress: Functional Review Board RAG — Slice 2 Backend Board Batch

## Status

completed — implemented the backend board read projection, workflow metadata persistence, priority/approval commands, failed-run attention visibility, and server-side 20 MB upload rejection. Frontend API integration, real vector RAG, and PDF export remain out of scope.

## Changed files

- `apps/api/tests/contract.test.mjs` — added RED/GREEN coverage for board route contracts, offline empty board response, and server-side upload size rejection/exact-boundary acceptance.
- `apps/api/tests/review-repository.test.mjs` — added durable board projection coverage for uploaded documents, queued runs, priority updates, human approval metadata, and failed/cancelled-run attention text.
- `apps/api/tests/live-review-integration.test.mjs` — added live API coverage for board cards from persisted upload/run data, priority update, approval, and failed-run visibility.
- `apps/api/tests/migrate-runner.test.mjs` — updated discovered-migration table expectations for the new workflow table.
- `apps/api/src/thesis-documents/upload-service.mjs` — added `MAX_THESIS_FILE_SIZE_BYTES` and rejects files larger than 20 MB before storage.
- `apps/api/src/db/migrations/0004_review_workflow_item.sql` — added durable reviewer workflow metadata table with priority, approval state, reviewer label, and current run link.
- `apps/api/src/db/review-repository.mjs` — creates workflow rows with documents/runs, projects board cards, updates priority, records approval, and includes failed/cancelled attention text.
- `apps/api/src/api-contract.mjs` — added board list, priority update, and approval route contracts using the live repository when configured.
- `apps/api/src/review-board/review-board.controller.ts` — added NestJS controller seam for board routes.
- `apps/api/src/app.module.ts` — registered the board controller.
- `apps/api/src/live-review-pipeline.mjs` — forwards upload metadata into durable thesis-document persistence for board student/title projection.
- `openspec/changes/functional-review-board-rag/tasks.md` — checked only completed Slice 2 backend tasks.
- `openspec/changes/functional-review-board-rag/apply-progress.md` — recorded this batch.

## RED evidence

- `pnpm --dir apps/api test` failed before implementation with expected new-test failures:
  - board routes missing from `listApiRoutes`;
  - `GET /api/v1/review-board/cards` returned 404 instead of an explicit empty board;
  - oversized upload reached storage and threw `oversized upload should not be stored`.

## GREEN evidence

- `pnpm --dir apps/api test` passed after implementation: 89 tests, 74 pass / 15 skipped under default DB env.
- `DATABASE_URL=postgres://pg1:pg1@localhost:55432/pg1 pnpm --dir apps/api test` passed after implementation: 89 tests, 89 pass, 0 skipped against local Postgres/pgvector.
- `pnpm --dir apps/web test` passed after implementation: 54 tests, 54 pass, 0 fail.
- `pnpm test` passed after implementation: API 89 tests with 74 pass / 15 skipped under default DB env, web 54 pass, worker 56 pass. Worker emitted existing warning text `EOF marker not found` but unittest result was OK.
- Parent verification flagged missing direct backend cancelled-board coverage; `apps/api/tests/review-repository.test.mjs` was triangulated with a cancelled-run board assertion.
- After the cancelled coverage addition, `DATABASE_URL=postgres://pg1:pg1@localhost:55432/pg1 pnpm --dir apps/api test` passed: 89 tests, 89 pass, 0 skipped.
- After the cancelled coverage addition, `pnpm --dir apps/api test` passed: 89 tests, 74 pass / 15 skipped under default DB env.

## Completed tasks

- Durable board cards projected from persisted thesis documents and review runs.
- Reviewer workflow metadata persisted separately from automated run status: priority, approval state, reviewer label, current review run link.
- Board state projection for pending, in-review, reviewed, approved, and failed/cancelled attention visibility, including direct backend cancelled-run coverage.
- Board API routes for listing cards, updating priority, and recording explicit reviewer approval.
- Server-side upload size limit rejects files over 20 MB before object storage; exactly 20 MB is accepted.
- Upload metadata now persists student/title values for board projection.

## Incomplete tasks

- Angular board/detail API integration remains a follow-up; the frontend sample seam was intentionally not changed in this backend-only batch.
- Real vector RAG remains out of scope.
- PDF export remains out of scope.

## Risks

- API board `current_review_run_id` currently uses a durable DB-derived public id (`review_run_<db_id>`), not the lifecycle route id (`run_<document_id>`), because the live pipeline only exposes the lifecycle-to-DB mapping one way.
- Default API tests still skip live Postgres cases when `DATABASE_URL` is not set/reachable; live coverage passed explicitly against `localhost:55432`.

## Next recommendation

Proceed to SDD verify for Slice 2 backend, then plan a small frontend API-integration batch for the Angular board/detail shell. Keep real vector retrieval in its separate RAG foundation slice.

---

# Apply Progress: Functional Review Board RAG — Slice 2 Frontend API Integration

## Status

completed — wired the Angular review board shell to prefer `GET /api/v1/review-board/cards` data while preserving clearly named demo fallback state. Real vector RAG and PDF export remain out of scope.

## Changed files

- `apps/web/tests/review-board-api.test.mjs` — added RED/GREEN coverage for the board API path, durable-card-to-view-model mapping, and API-over-demo fallback selection.
- `apps/web/tests/review-pages.test.mjs` — updated shell source assertions for the API seam and demo fallback naming.
- `apps/web/src/app/review-board/review-board-api.ts` — added pure API response mapping and display-source selection helpers for the board route.
- `apps/web/src/app/review-board/review-board-page.ts` — loads board cards from `/api/v1/review-board/cards`, renders API data when available, and uses `DEMO_FALLBACK_REVIEW_BOARD_CARDS` only when the API is unavailable.
- `apps/web/src/app/review-board/review-board-view.ts` — allowed API-derived current-run and attention text metadata to flow through existing board cards.
- `apps/web/src/app/review-board/student-review-page.ts` — renamed sample detail data to clearly identified demo fallback state and removed stale “persistence not added” wording.
- `openspec/changes/functional-review-board-rag/tasks.md` — checked the Slice 2 frontend API integration task.
- `openspec/changes/functional-review-board-rag/apply-progress.md` — recorded this batch.

## RED evidence

- `pnpm --dir apps/web test -- tests/review-board-api.test.mjs` failed before implementation with the expected missing module error for `apps/web/src/app/review-board/review-board-api.ts`; the suite reported 54 pass / 1 fail.

## GREEN evidence

- `pnpm --dir apps/web test -- tests/review-board-api.test.mjs tests/review-pages.test.mjs` passed after implementation: 56 tests, 56 pass, 0 fail.
- `pnpm --dir apps/web test` passed after implementation: 56 tests, 56 pass, 0 fail.
- `pnpm test` passed after implementation: API 89 tests with 74 pass / 15 skipped under default DB env, web 56 pass, worker 56 pass. Worker emitted existing non-failing `EOF marker not found` text.

## Completed tasks

- Angular board shell now has a clear `GET /api/v1/review-board/cards` seam.
- API cards are normalized into the existing board view model and empty API lists do not fall back to demo cards.
- Demo data remains clearly named as fallback/demo state.
- UI copy remains truthful: Rules + CAG review; no vector RAG claim.

## Incomplete tasks

- Real vector RAG remains out of scope.
- PDF export remains out of scope.
- Dedicated persisted student-detail API integration remains a future slice; the detail shell keeps clearly named demo fallback data while upload/review APIs remain the persisted-run path.

## Risks

- The board page uses browser `fetch` directly for the small read seam; no Angular TestBed/browser integration test was added in this batch.
- Dedicated student-detail API data is still not available, so detail cards remain demo fallback state.

## Next recommendation

Settle this attempt as the Slice 2 frontend API-integration completion. Keep real vector retrieval and dedicated student-detail API integration as separate future slices.

---

# Apply Progress: Functional Review Board RAG — Slice 3 Real RAG Foundation

## Status

completed — implemented a bounded real RAG foundation: normative segment seeding, deterministic embedding-provider abstraction, pgvector persistence/retrieval, API-to-worker retrieved-context injection, and provenance metadata when retrieved context is actually used. UI redesign and PDF export remained out of scope.

## Changed files

- `apps/api/tests/review-repository.test.mjs` — added RED/GREEN coverage for normative segment seeding, embedding persistence, and similarity retrieval.
- `apps/api/tests/review-orchestrator.test.mjs` — added RED/GREEN coverage proving retrieved context reaches the worker call and proving fallback CAG does not claim retrieved-context provenance when retrieval is unavailable.
- `services/worker/tests/test_cag_review.py` — added RED/GREEN coverage proving retrieved-context prompts use retrieved segments instead of the full-corpus CAG prompt.
- `apps/api/src/db/migrations/0005_normative_rag_indexes.sql` — added unique/idempotency indexes and a pgvector cosine index for embedding retrieval.
- `apps/api/src/embeddings/deterministic-embedding-provider.mjs` — added a local deterministic 1536-dimension embedding provider abstraction for tests/local retrieval without network/API keys.
- `apps/api/src/db/review-repository.mjs` — added normative segment seeding, embedding persistence, and pgvector similarity retrieval methods.
- `apps/api/src/jobs/review-orchestrator.mjs` — retrieves normative context when available, sends it to CAG review, and persists retrieved-context provenance only for retrieved-context runs.
- `apps/api/src/live-review-pipeline.mjs` — wires the deterministic embedding provider and retrieval into the live pipeline while preserving CAG fallback.
- `services/worker/app/cag_review.py` — accepts retrieved context and builds a retrieved-context prompt; full-corpus CAG remains the fallback when context is absent; malformed provider confidence now raises explicit `CagReviewError` instead of a raw `ValueError`.
- `services/worker/app/main.py` — accepts `rag_context` in `/internal/review` and forwards it to the CAG review function.
- `openspec/changes/functional-review-board-rag/tasks.md` — checked completed Slice 3 RAG foundation tasks.
- `openspec/changes/functional-review-board-rag/apply-progress.md` — recorded this batch.

## RED evidence

- `pnpm --dir apps/api exec node --import tsx --test --test-concurrency=1 tests/review-orchestrator.test.mjs` failed before implementation with expected new-test failures: retrieved context was `undefined` in the CAG call, and `defaultRunCagReview` omitted `rag_context` from the worker body.
- `pnpm --dir services/worker exec python3 -m unittest tests.test_cag_review.CagReviewTest.test_retrieved_context_prompt_uses_only_retrieved_segments_as_real_rag_context` failed before implementation with `TypeError: run_cag_review() got an unexpected keyword argument 'retrieved_context'`.
- `DATABASE_URL='postgres://pg1:pg1@localhost:55432/pg1' pnpm --dir apps/api exec node --import tsx --test --test-concurrency=1 tests/review-repository.test.mjs` failed before implementation with `repository.seedNormativeSegments is not a function`.

## GREEN evidence

- `pnpm --dir apps/api exec node --import tsx --test --test-concurrency=1 tests/review-orchestrator.test.mjs` passed after implementation: 12 tests, 9 pass / 3 skipped under default DB env.
- `pnpm --dir services/worker exec python3 -m unittest tests.test_cag_review.CagReviewTest.test_retrieved_context_prompt_uses_only_retrieved_segments_as_real_rag_context` passed after implementation: 1 test, OK.
- `DATABASE_URL='postgres://pg1:pg1@localhost:55432/pg1' pnpm --dir apps/api exec node --import tsx --test --test-concurrency=1 tests/review-repository.test.mjs` passed after implementation: 5 tests, 5 pass.
- `pnpm --dir services/worker test` passed: 57 tests, OK. Existing non-failing warnings were still emitted (`StarletteDeprecationWarning`, `EOF marker not found`).
- `DATABASE_URL='postgres://pg1:pg1@localhost:55432/pg1' pnpm --dir apps/api test` passed: 92 tests, 92 pass.
- `pnpm test` passed: API 92 tests with 76 pass / 16 skipped under default DB env, web 56 pass, worker 57 pass. Worker emitted existing non-failing `StarletteDeprecationWarning` and `EOF marker not found` text.
- Parent post-run diagnostics found worker typing/lint issues and two unused test parameters. Corrective TDD added invalid-confidence coverage in `services/worker/tests/test_cag_review.py`, wrapped provider confidence coercion in a `CagReviewError`, replaced mutable Pydantic defaults with `Field(default_factory=...)`, and removed stale TypeScript unused-parameter diagnostics.
- Parent reran focused and full verification after corrections: `pnpm --dir services/worker test` passed with 58 tests; `DATABASE_URL=postgres://pg1:pg1@localhost:55432/pg1 pnpm --dir apps/api test` passed with 92 tests; `pnpm test` passed with API 92 tests (76 pass / 16 skipped), web 56 pass, worker 58 pass.
- Parent LSP diagnostics on touched API/worker files reported 0 diagnostics. One ast-grep false positive on intentional `CagReviewError` validation was suppressed inline with `pi-lens-ignore` after tests proved malformed provider output is handled explicitly.

## Completed tasks

- Normative text files are split into persisted `normative_segment` rows.
- A deterministic local embedding provider abstraction supplies 1536-dimension vectors without network/API keys.
- Normative embeddings are persisted in `embedding_record` using pgvector.
- Similarity retrieval returns persisted normative segments with source refs and similarity scores.
- Retrieved normative context is injected into the worker review path and used in the worker prompt.
- Retrieved-context provenance is persisted only when retrieval actually supplied context; CAG fallback remains unlabeled as retrieved-context RAG.

## Incomplete tasks

- External semantic embedding providers remain future work; this slice uses deterministic local embeddings to establish the storage/retrieval contract.
- No UI redesign or PDF export was implemented.

## Risks

- The deterministic embedding provider is a local foundation/fake-quality retrieval model, not a production semantic embedding model.
- Live pipeline seeds/reuses embeddings lazily during review; this is simple and bounded for the current small corpus but may need a background seeding job for larger corpora.

## Next recommendation

Run SDD verify for Slice 3, then archive or plan a separate production embedding-provider slice if stronger semantic retrieval is required.
