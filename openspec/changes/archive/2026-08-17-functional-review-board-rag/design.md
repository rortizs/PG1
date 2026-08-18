# Design: Functional Review Board and Report Workflow

## status

success — generated from proposal/spec after local SDD phase agents failed with provider network errors.

## decision_summary

Build the first slice as a functional UI/read-model layer over existing PG1 upload, review-run, findings, and report-artifacts APIs. Do not bundle real pgvector RAG into the UI slice. Preserve technical truth: current AI review is CAG/full-corpus prompting plus deterministic rules.

## architecture

```text
Reviewer UI
  ├─ Review Board route
  ├─ Student Detail route
  ├─ Upload/dropzone
  ├─ Progress projection
  └─ Markdown report download
        │
        ▼
NestJS API contracts
  ├─ POST /api/v1/thesis-documents
  ├─ POST /api/v1/thesis-documents/{id}/review-runs
  ├─ GET  /api/v1/review-runs/{id}
  ├─ GET  /api/v1/review-runs/{id}/findings
  └─ GET  /api/v1/review-runs/{id}/report-artifacts
        │
        ▼
Worker pipeline
  ├─ extraction: pages, sections, full_text
  ├─ optional MarkItDown: llm_text
  ├─ deterministic rules
  └─ CAG review
        │
        ▼
Postgres persistence + Markdown report artifact
```

## frontend_design

### Routes

Add routes conceptually equivalent to:

- `/board` — review board.
- `/students/:studentId/review` or `/reviews/:runId` — student review detail.

Route names can be adjusted to the existing Angular conventions during implementation.

### View models

Use pure, framework-light view-model functions first so behavior can be tested without Angular TestBed.

Recommended modules:

- `review-board-view.ts`
  - map lifecycle statuses to board columns;
  - group cards by board state;
  - sort/filter by priority;
  - preserve failed/cancelled visibility.
- `review-progress-view.ts`
  - map lifecycle status to stage label and projected percent;
  - expose failure/completed states.
- `report-download-view.ts`
  - select Markdown artifact;
  - build downloadable blob metadata.

### Components

- `ReviewBoardPage`
  - Kanban columns: Pending, In Review, Reviewed, Approved.
  - Cards show student, thesis title, priority, stage/evidence line, reviewer, report readiness.
- `StudentReviewPage`
  - Header with student state/priority/reviewer.
  - Dropzone upload control.
  - Progress panel.
  - Summary/report panel.
  - Checklist panel.

### Styling

Follow Stitch direction:

- warm paper surfaces;
- ink-like text;
- subtle borders/dividers;
- restrained priority indicators;
- no heavy dashboard visuals.

## backend_design

### First slice

Use existing endpoints where possible:

- Upload via `POST /api/v1/thesis-documents`.
- Start analysis via `POST /api/v1/thesis-documents/{id}/review-runs`.
- Poll run via `GET /api/v1/review-runs/{id}`.
- Fetch findings via `GET /api/v1/review-runs/{id}/findings`.
- Fetch Markdown report via `GET /api/v1/review-runs/{id}/report-artifacts`.

If real board data is unavailable, the first slice may use a small API-backed projection from existing documents/runs or a demo fixture behind a clearly named demo seam. Avoid hiding missing persistence behind fake production claims.

### Later backend slice

Add durable board support:

- priority persistence;
- reviewer assignment;
- approval state;
- board list endpoint;
- failed/cancelled display semantics.

## file_validation_design

Validation must be duplicated at client and server boundaries:

- accepted extensions/types: `.pdf`, `.docx`;
- maximum file size: 20 MB;
- exactly one file.

Client-side validation improves UX. Server-side validation protects the system.

## progress_design

The current backend lifecycle has coarse statuses, not real worker percentage events. The first UI should use deterministic projected percentages from lifecycle status and label them as analysis progress, not true byte-level progress.

Suggested mapping:

| Raw status | Stage | Percent |
| --- | --- | ---: |
| queued | Uploading | 10 |
| extracting | Extracting text | 30 |
| segmenting | Extracting text | 45 |
| validating | Running rules | 60 |
| rag_reviewing | Running review | 75 |
| reporting | Generating report | 90 |
| completed | Completed | 100 |
| failed | Failed | 100 |
| cancelled | Cancelled | 100 |

## report_download_design

The API returns Markdown artifacts as JSON items. UI should:

1. select the first item where `kind === 'markdown'` or `content_type` starts with `text/markdown`;
2. create a `Blob` with Markdown content;
3. download using the artifact filename;
4. disable/hide download until artifact is available.

## cag_rag_design

### Current

- CAG loads static corpus into one prompt.
- Deterministic rules produce separate findings.
- MarkItDown can provide `llm_text` for LLM-friendly review.

### Future real RAG

Add separately:

- source chunker/segment seeder;
- embedding provider;
- pgvector storage/query;
- retrieved context builder;
- provenance in findings and reports.

## testing_design

Use strict TDD:

1. Write RED tests for pure view models.
2. Verify failures.
3. Implement minimal code.
4. Run targeted tests.
5. Run `pnpm test` before claiming completion.

BDD scenarios from `spec.md` should drive tests.

## risks

- Real progress UI may overstate precision if not clearly derived from lifecycle status.
- Kanban without durable backend state can be demo-only unless clearly scoped.
- RAG/vector work is architecturally larger and should not be bundled into the first UI implementation.

## next_recommended

Proceed to `sdd-tasks` for Slice 1 first. Keep Slice 2 and Slice 3 as follow-up task groups.

## skill_resolution

paths-injected

## slice_2_backend_board_design

Slice 2 adds durable reviewer workflow state and a board API without changing the worker's CAG/rules pipeline.

### Data model

Store reviewer workflow metadata separately from `review_run.status` so human workflow state does not corrupt automated lifecycle evidence.

Recommended minimal table/concept:

- `review_workflow_item`
  - `id`
  - `thesis_document_id`
  - `review_run_id` nullable/current
  - `priority`: `low | normal | urgent`
  - `approval_state`: `not_approved | approved`
  - `reviewer_name` nullable text for demo/read-model use
  - timestamps

If a smaller implementation is needed, repository-level projection can start from existing `thesis_document`/`review_run` rows and add workflow fields in one migration.

### API contract

Add durable board behavior behind versioned API routes, for example:

- `GET /api/v1/review-board/cards`
- `PATCH /api/v1/review-board/cards/{card_id}/priority`
- `POST /api/v1/review-board/cards/{card_id}/approval`

The exact route names may follow existing controller conventions, but the response must be stable enough for the Angular board to consume.

### Board projection

Projection rules:

- Explicit approval wins: `approval_state = approved` -> `approved`.
- Active lifecycle statuses -> `in_review`.
- `completed` without approval -> `reviewed`.
- no review run -> `pending`.
- `failed` and `cancelled` stay visible with `attention`.

### Upload size enforcement

Server-side upload validation must reject files over 20 MB before storage, document persistence, or review-run creation. Exactly 20 MB is accepted.

### Frontend integration

The Angular board should prefer API cards. Existing sample data remains only as a clearly named fallback/demo seam, never as persisted production data.

### Testing

Strict TDD remains mandatory. Start with API contract/repository tests, then implement persistence/projection, then wire frontend fetch behavior.
