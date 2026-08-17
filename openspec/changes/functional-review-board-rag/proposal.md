# Proposal: Functional Review Board and Real RAG Foundation

## status

success — proposal synthesized from the accepted product direction, Stitch UX artifacts, and the exploration artifact after the dedicated `sdd-proposal` provider failed with a network error.

## executive_summary

PG1 should evolve from a single upload/results flow into a reviewer workspace: a Kanban board for thesis review state, a student detail upload/analysis page, and downloadable Markdown reports. The first implementation should prioritize the functional review workflow and report access. Real pgvector-backed RAG should be treated as a separate foundation slice because the current implemented AI path is CAG/full-corpus prompting, not vector retrieval.

## problem_statement

Real thesis reviewers need a calm, evidence-first workspace to track students through review, upload thesis files, monitor analysis, and download formal Markdown reports. Today PG1 can upload and analyze documents, but it lacks the operational review board, student workflow state, priorities, progress UX, and true vector retrieval needed for a complete reviewer-facing system.

## users

- **Thesis reviewer:** reviews submissions, reads generated findings, downloads Markdown report, decides whether the thesis is approved.
- **Academic coordinator:** monitors workload, urgency, and review state across students.
- **Developer/analyst:** maintains the CAG/rules/RAG pipeline and needs accurate technical visibility into current vs planned behavior.

## goals

1. Add a minimal Kanban review board with states: `Pending`, `In Review`, `Reviewed`, `Approved`.
2. Add priorities: `Low`, `Normal`, `Urgent`.
3. Add a student detail flow for PDF/DOCX upload with 20 MB max file size.
4. Move a student automatically to `In Review` when analysis starts.
5. Show analysis stage/percentage and final report summary.
6. Expose Markdown report download from the UI.
7. Preserve human control: `Approved` is only set by a reviewer, never by automation.
8. Clearly separate current CAG from future real RAG/vector retrieval.

## non_goals

- No automatic thesis approval.
- No PDF report export in this slice.
- No heavy dashboard or decorative UI.
- No false claim that vector RAG exists before embeddings/retrieval are implemented.
- No broad rewrite of ingestion, worker, or review orchestration.
- No OneDrive integration.

## proposed_slices

### Slice 1 — Functional reviewer UX shell

Build the review-board and student-detail UI using existing backend contracts where possible.

Includes:

- Board route and view model.
- Status-to-board mapping.
- Priority model in UI/read model.
- Student detail upload page.
- 20 MB validation.
- Markdown download affordance.

This is the best first demo slice because it turns existing analysis/report capabilities into a usable reviewer workflow.

### Slice 2 — Backend board contract and persistence

Add API/data support for real board cards and workflow state.

Includes:

- list/query endpoint for board cards;
- persisted priority;
- explicit approval state;
- reviewer assignment if required;
- failed/cancelled visibility.

### Slice 3 — Real RAG foundation

Add true pgvector-backed retrieval without weakening existing CAG/rules behavior.

Includes:

- normative segment seeding;
- embedding provider abstraction;
- vector storage in pgvector;
- similarity retrieval;
- review prompt context injection;
- tests proving retrieval happened or, when unavailable, no RAG claim is made.

## acceptance_criteria

### Board workflow

- Given a reviewer opens the review board, when there are thesis submissions, then cards are grouped into `Pending`, `In Review`, `Reviewed`, and `Approved`.
- Given a card has priority `Urgent`, when the board renders, then it is visually distinguishable without using loud colors.
- Given a run is failed or cancelled, when the board renders, then it is not hidden inside a successful column.

### Student detail and upload

- Given a reviewer clicks a pending student, when the detail page opens, then they can upload/drop one PDF or DOCX file.
- Given the file exceeds 20 MB, when selected, then the UI blocks upload with a clear message before creating a review run.
- Given the file is accepted, when upload starts, then the student is shown as `In Review`.
- Given analysis is running, when progress updates are available or projected, then the page shows stage and percentage.

### Report

- Given a review run completed, when the detail page loads, then it shows a global summary and a `Download Markdown Report` action.
- Given the report artifact is available from the API, when the reviewer downloads it, then the file is saved as `.md` with Markdown content.

### RAG/CAG truthfulness

- Given only CAG is configured, when a report is generated, then the system must not claim vector RAG retrieval was used.
- Given vector RAG is later configured, when retrieval occurs, then retrieved sources must be traceable.

## data_and_backend_implications

- Add or project a board state separate from raw lifecycle status.
- Add priority (`Low`, `Normal`, `Urgent`) to a durable read model or persistence layer.
- Add explicit approval semantics for the terminal `Approved` state.
- Add 20 MB enforcement at client and server boundaries.
- Decide whether Markdown report artifacts remain dynamic or become persisted report artifacts.
- Add vector/RAG tables usage only in the dedicated RAG slice.

## rag_cag_positioning

Current PG1 review uses:

- deterministic rules;
- CAG/full-corpus prompting in `services/worker/app/cag_review.py`;
- Postgres persistence;
- Markdown report artifacts.

Planned real RAG requires:

- chunked institutional/APA/rubric sources;
- embeddings;
- pgvector similarity search;
- retrieved context injection;
- provenance in findings/report output.

The product language should avoid calling the current CAG implementation “real RAG” until retrieval is implemented.

## review_workload_forecast

- Slice 1 is likely medium-sized but should be split into small files/view models/tests to stay under the 400-line review budget.
- Slice 2 involves API/data model changes and should be separate.
- Slice 3 is architectural and should be separate from UI work.
- Chained PRs may be recommended if UI + backend + RAG are attempted together. Recommended approach: start with Slice 1 only.

## risks_and_tradeoffs

- A synchronous backend pipeline can make real progress percentages hard; early UI may need stage projection based on lifecycle status.
- Adding board state without persistence is fast for demo but not durable.
- Adding persistence too early increases migration/API scope.
- Real RAG is valuable but materially larger than UI workflow and should not be bundled with the first functional UI slice.
- The Stitch technical diagram failed to materialize after timeout; design can use a Mermaid diagram if Stitch remains unavailable.

## next_recommended

Proceed to `sdd-spec` and `sdd-design`, scoped first to Slice 1 unless the user explicitly accepts chained delivery for backend persistence and real RAG.

## skill_resolution

paths-injected
