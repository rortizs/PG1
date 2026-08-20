# Archive Report: functional-review-board-rag

## status

**archived** — implementation, verification, and delivery completed for the functional review board and real pgvector-backed RAG foundation milestone. All 37 implementation tasks are complete, verify-report shows PASS with 17/17 scenarios compliant, and the change has been merged and pushed to the live repository.

## final_delivery_facts

Incorporated from post-verification final-state evidence (rank: explicit facts in orchestrator launch prompt outrank intermediate snapshots):

1. **Delivered as 6 work-unit commits** on branch `feat/functional-review-board-rag` (branched from master):
   - d2db929: pure UI helpers (review-board-view, review-progress-view, report-download-view, upload validation)
   - dea543a: Angular board/detail pages and routes
   - d02f1d0: enforce 20MB thesis upload size limit server-side
   - a02b0cb: board persistence and API, migration 0004, board controller
   - 4cb52ba: pgvector-backed normative retrieval and RAG-grounded review
   - 153a6e6: OpenSpec change artifacts docs

2. **Bugfix applied after verify-report.md was written:**
   - Stale copy in `apps/web/src/app/review-board/review-board-page.ts` and `student-review-page.ts` stating "Source retrieval is not part of this slice" was corrected (falsely claimed no retrieval when Slice 3's pgvector RAG was already implemented)
   - Two stale guarding tests in `review-pages.test.mjs` asserting `doesNotMatch(/vector RAG/i)` were fixed to reflect the actual implemented behavior

3. **README.md rewritten** (commit 989a926):
   - Replaced professor's placeholder notes with real project documentation
   - Moved historical notes to docs/normativa-catedra.md

4. **Merged and pushed to live repository:**
   - `feat/functional-review-board-rag` was fast-forward merged into `master`
   - `master` was pushed directly to `origin/main` on GitHub (https://github.com/rortizs/PG1.git)
   - This replaced the remote's previously-unrelated history — the live state of `main` is now this implementation
   - All work is fully merged, pushed, and live — no pending PR, no pending merge, no blocking work

## shipped scope

### Slice 1 — Functional reviewer UX shell
- Review board and student review detail routes
- Pure view-model functions: board-state mapping, progress projection, report download, upload validation
- Truthful Rules + CAG labeling (does not falsely claim vector RAG)
- Angular review-board page and student-review-page with clear sample data seams

### Slice 2 — Backend board persistence
- Durable review board projection from persisted thesis documents and review runs
- Reviewer workflow metadata persistence: priority, approval state, reviewer label, current review-run link
- Human-only approval state enforcement (no automation can set `approved`)
- Failed/cancelled runs remain visible with attention field
- Server-side 20 MB upload enforcement before persistence, storage, or review-run creation
- Angular board page prefers `GET /api/v1/review-board/cards` API, uses demo cards only as fallback
- Board state projection rules: running statuses → `in_review`, completed unapproved → `reviewed`, explicit approval → `approved`

### Slice 3 — Real RAG foundation
- Normative segment seeding (idempotent)
- Deterministic local embedding provider abstraction (foundation/testing implementation, not production semantic embeddings)
- pgvector-backed embedding persistence and similarity retrieval
- Retrieved normative context injection into worker review prompt
- Retrieval provenance persisted only when retrieved context was actually used
- Full-corpus CAG fallback remains available and is not falsely labeled as retrieved-context RAG

## verification evidence

**Verdict: PASS** — per `verify-report.md` validated by `gentle-ai sdd-verify-validate --requirements 9 --scenarios 17`

| Metric | Value |
|--------|-------|
| Tasks total | 37 |
| Tasks complete | 37 |
| Tasks incomplete | 0 |
| Requirements compliant | 9/9 |
| Scenarios compliant | 17/17 |
| Critical findings | 0 |
| Test exit code | 0 |

**Test runs:**
- `pnpm --dir services/worker test` → 58 tests OK
- `DATABASE_URL='postgres://pg1:pg1@localhost:55432/pg1' pnpm --dir apps/api test` → 92 tests, 92 pass, 0 skipped, 0 fail
- `pnpm test` → API 92 tests with 76 pass / 16 skipped under default DB env, web 56 pass, worker 58 OK
- LSP diagnostics on touched API/worker/frontend files → 0 diagnostics

**Scenario matrix:**
- 9 requirements, 17 scenarios distributed across:
  - Durable Review Board Cards (2 scenarios)
  - Priority and Approval Workflow State (2 scenarios)
  - Board State Projection (3 scenarios)
  - Server-Side Thesis Upload Size Limit (2 scenarios)
  - Upload-To-Board Transition (1 scenario)
  - Normative Segment and Embedding Index (2 scenarios)
  - Similarity Retrieval and Fallback Honesty (2 scenarios)
  - Retrieved Context Review Provenance (2 scenarios)
  - Functional Reviewer UX Shell (1 scenario)

All scenarios rated ✅ COMPLIANT per the spec compliance matrix in verify-report.md.

## accepted constraints and decisions

- `Approved` remains terminal and human-controlled (no automated approval path)
- Reports remain Markdown-first; PDF export stays out of scope
- Current deterministic embedding provider is an explicit foundation/testing implementation, not a production semantic embedding provider
- The UI remains honest: it does not claim vector RAG unless retrieved context exists and was used
- Server-side and client-side upload size checks both enforce the 20 MB limit
- Tested with deterministic local embeddings; production embeddings remain a later hardening step

## known follow-ups (explicitly documented, remain open)

1. **Production semantic embedding provider** — current deterministic embeddings establish storage/retrieval contract and foundation behavior, not semantic-quality retrieval. A real semantic embedding provider should be planned as a later hardening slice if higher-quality vector search is required.

2. **Background/index maintenance job** — no job exists yet if the normative corpus grows. Current implementation assumes stable, small normative corpus.

3. **Student-detail page API integration** — detail page still uses clearly named demo/fallback data for some views. Dedicated student-detail API integration can be a follow-up change.

## archival checklist

- [x] All tasks complete: 37/37 checked, 0 unchecked
- [x] Verification passed: PASS verdict, 0 critical findings, 17/17 scenarios compliant
- [x] Main spec merged: new `openspec/specs/reviewer-workflow-board/spec.md` created from delta
- [x] Change folder archived: moved to `openspec/changes/archive/2026-08-17-functional-review-board-rag/`
- [x] Archive contents verified: mandatory diff-r readback passed (empty diff)
- [x] No unchecked implementation tasks in archived tasks.md
- [x] Delivery complete: merged to master, pushed to origin/main, live on GitHub

## delta spec sync

**Action: CREATED** — new capability `reviewer-workflow-board`

New spec `openspec/specs/reviewer-workflow-board/spec.md` contains:
- 9 ADDED requirements (no existing main spec)
- 1 MODIFIED requirement (Functional Reviewer UX Shell — board UI now prefers API data)
- 17 scenarios total

All requirements and scenarios are now the source of truth for this capability and reflected in the main spec directory.

## artifacts archived

Located in `/Users/richardortiz/workspace/Learning/PG1/openspec/changes/archive/2026-08-17-functional-review-board-rag/`:
- proposal.md
- spec.md (change-scoped overview)
- specs/reviewer-workflow-board/spec.md (delta spec, now synced to main specs/)
- design.md
- tasks.md (37/37 complete)
- apply-progress.md (Slice 1 and Slice 2 progress records)
- verify-report.md (PASS verdict with evidence)
- archive-report.md (this document)

## final recommendation

Treat `functional-review-board-rag` as **complete and closed** for the functional review board + real RAG foundation milestone. The change is merged, live, and verified.

**Next steps are independent follow-ups:**
- Plan production semantic embeddings as a later hardening slice
- Plan background corpus maintenance if normative content grows
- Plan dedicated student-detail API integration if full durable detail page state is needed

## skill_resolution

paths-injected
