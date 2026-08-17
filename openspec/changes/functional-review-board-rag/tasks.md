# Tasks: Functional Review Board and Report Workflow

## status

success — generated after dedicated `sdd-tasks` provider failed with a network error.

## selected_slice

Slice 1 only: functional reviewer UX shell. Backend persistence and true pgvector RAG are follow-up slices.

## Review Workload Forecast

- Estimated changed lines: 250–390 for Slice 1.
- 400-line budget risk: Medium.
- Chained PRs recommended: No for Slice 1 only.
- Decision needed before apply: No.
- If backend persistence or real RAG is added to this apply, chained PRs become recommended.

## Slice 1 tasks

- [x] Add `apps/web/tests/review-board-view.test.mjs` with RED tests for mapping lifecycle statuses to `Pending`, `In Review`, `Reviewed`, `Approved`, including failed/cancelled visibility.
- [x] Add `apps/web/src/app/review-board/review-board-view.ts` with pure board view-model functions and priority sorting.
- [x] Add `apps/web/tests/review-progress-view.test.mjs` with RED tests for stage/percentage projection from review-run lifecycle statuses.
- [x] Add `apps/web/src/app/review-board/review-progress-view.ts` with deterministic projected progress labels and percentages.
- [x] Extend `apps/web/tests/upload-validation.test.mjs` with RED tests for the 20 MB max file size while preserving PDF/DOCX validation.
- [x] Update `apps/web/src/app/upload/upload-validation.ts` with 20 MB validation.
- [x] Add `apps/web/tests/report-download-view.test.mjs` with RED tests for selecting Markdown report artifacts and creating download metadata.
- [x] Add `apps/web/src/app/results/report-download-view.ts` or equivalent pure helper for Markdown artifact download behavior.
- [x] Add Angular review-board page/component and route using the pure board view model.
- [x] Add student review detail page/component and route using upload validation, progress projection, and report download helpers.
- [x] Keep UI copy truthful: current analysis can say rules + CAG, but must not claim real vector RAG.
- [x] Run targeted web tests for the new view-model helpers.
- [x] Run root `pnpm test` before completion.

## Slice 2 — Backend board persistence

- [x] Add API tests for persisted board cards built from uploaded documents and review runs.
- [x] Add API tests for priority update without mutating review-run lifecycle status.
- [x] Add API tests for human approval moving completed items to `approved` board state only through workflow metadata.
- [x] Add API tests proving failed/cancelled runs remain visible with attention text.
- [x] Add API tests for server-side 20 MB upload rejection and exact-boundary acceptance.
- [x] Add or extend persistence for reviewer workflow metadata: priority, approval state, reviewer label when available.
- [x] Add board-state projection in API contract/repository code.
- [x] Add real board list endpoint returning durable cards.
- [x] Add priority/approval update endpoints or commands.
- [x] Add server-side 20 MB enforcement before persistence/storage/review creation.
- [x] Update Angular board/detail shell to prefer API board data while keeping the sample seam only as fallback/demo state.
- [x] Run targeted API/web tests, root `pnpm test`, and API live tests against `localhost:55432`.

## Follow-up slice 3 — Real RAG foundation

- [x] Seed normative segments.
- [x] Add embedding provider abstraction.
- [x] Store vectors in pgvector.
- [x] Add similarity retrieval.
- [x] Inject retrieved context into review.
- [x] Add tests proving retrieval happened, and tests preventing false RAG claims when unavailable.

## BDD checkpoints

- [x] Under-20 MB PDF/DOCX upload starts review and moves card to `In Review`.
- [x] Oversized/unsupported file is blocked before API submission.
- [x] Running lifecycle statuses appear in `In Review` with stage and percentage.
- [x] Completed run appears in `Reviewed` and exposes Markdown download.
- [x] `Approved` remains human-controlled.
- [x] UI/report does not claim vector RAG unless retrieval exists.

## next_recommended

Proceed to `sdd-verify` for the completed board + RAG foundation milestone. A production semantic embedding provider can be planned as a later hardening slice if deterministic local embeddings are not sufficient.

## skill_resolution

paths-injected
