# Archive Report: functional-review-board-rag

## status

archived-ready — implementation and strict verification completed for the reviewer workflow board milestone and real RAG foundation slice. Native status reported `archive: ready` after the strict verify envelope was validated.

## shipped scope

- Slice 1 UI shell:
  - Review board and student review routes.
  - Pure board/progress/upload/report helpers.
  - Markdown report download helper.
  - Truthful Rules + CAG labeling.
- Slice 2 board workflow:
  - Durable review board projection from persisted thesis documents and review runs.
  - Reviewer workflow metadata for priority, approval state, reviewer label, and current run link.
  - Human-only approval state.
  - Failed/cancelled runs remain visible with attention text.
  - Server-side 20 MB upload enforcement before persistence/storage/review creation.
  - Angular board page prefers `GET /api/v1/review-board/cards` and uses demo cards only as fallback.
- Slice 3 RAG foundation:
  - Normative segment seeding.
  - Deterministic local embedding provider abstraction.
  - pgvector-backed embedding persistence and similarity retrieval.
  - Retrieved normative context injection into the worker review prompt.
  - Retrieval provenance persisted only when retrieved context was actually used.
  - Full-corpus CAG fallback remains available and is not falsely labeled as retrieved-context RAG.

## verification evidence

- `gentle-ai sdd-verify-validate --input openspec/changes/functional-review-board-rag/verify-report.md --requirements 9 --scenarios 17` → valid true, verdict pass.
- `pnpm --dir services/worker test` → 58 tests OK.
- `DATABASE_URL='postgres://pg1:pg1@localhost:55432/pg1' pnpm --dir apps/api test` → 92 tests, 92 pass, 0 skipped, 0 fail.
- `pnpm test` → API 92 tests with 76 pass / 16 skipped under default DB env, web 56 pass, worker 58 OK.
- LSP diagnostics on touched API/worker/frontend files → 0 diagnostics.

## accepted constraints and decisions

- `Approved` remains terminal and human-controlled.
- Reports remain Markdown-first; PDF export stays out of scope.
- Current deterministic embedding provider is a foundation/testing implementation, not a production semantic embedding provider.
- The UI remains honest: it does not claim vector RAG unless retrieved context exists.
- Server-side and client-side upload size checks both enforce the 20 MB limit.
- Native runtime overages were explicitly authorized by the maintainer before resets/continuation.

## follow-ups

- Add a production semantic embedding provider if higher-quality retrieval is required.
- Add a background/index maintenance job if normative corpus size grows.
- Add dedicated student-detail API integration; the detail page still uses clearly named demo fallback state.
- Decide whether to create a separate delivery PR/commit sequence because this change is large and spans API, worker, web, and OpenSpec artifacts.

## artifact list

- `openspec/changes/functional-review-board-rag/proposal.md`
- `openspec/changes/functional-review-board-rag/spec.md`
- `openspec/changes/functional-review-board-rag/specs/reviewer-workflow-board/spec.md`
- `openspec/changes/functional-review-board-rag/design.md`
- `openspec/changes/functional-review-board-rag/tasks.md`
- `openspec/changes/functional-review-board-rag/apply-progress.md`
- `openspec/changes/functional-review-board-rag/verify-report.md`
- `openspec/changes/functional-review-board-rag/archive-report.md`

## final recommendation

Treat `functional-review-board-rag` as complete for the current board + RAG foundation milestone. Plan production embeddings and student-detail API integration as separate future changes.
