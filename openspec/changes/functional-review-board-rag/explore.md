# functional-review-board-rag — Exploration

## status

complete — read-only mapping completed through CodeGraph-first exploration and fallback general explorer after the dedicated `sdd-explore` provider failed.

## executive_summary

- PG1 already has upload → review-run → results flow backed by API contracts, Nest controllers, Postgres schema, worker extraction/rules/CAG, Markdown report artifacts, and tests.
- PG1 does **not** yet have the requested functional review board UX, student detail upload flow, board states/priorities, 20 MB cap, percent progress UI, or UI Markdown download.
- Current “RAG” behavior is actually CAG/full-corpus prompt: `services/worker/app/cag_review.py` loads the static academic corpus into one LLM prompt and explicitly does not use chunking or embeddings.
- PostgreSQL runs locally with a pgvector-capable image, and migrations include vector-related tables, but real embedding generation and similarity retrieval are not implemented.
- First implementation should split UI/workflow from real vector RAG to protect review size and demo confidence.

## current_state

- Web routes in `apps/web/src/app/app.routes.ts`:
  - `/upload` → `UploadPage`
  - `/runs/:runId` → `ResultsPage`
  - `/admin/llm-providers`
- Upload UI in `apps/web/src/app/upload/upload-page.ts` selects one file, uploads to `POST /api/v1/thesis-documents`, triggers `POST /api/v1/thesis-documents/:id/review-runs`, then navigates to `/runs/:runId`.
- Upload validation in `apps/web/src/app/upload/upload-validation.ts` accepts PDF/DOCX but does not enforce the 20 MB product cap yet.
- Results UI in `apps/web/src/app/results/results-page.ts` / `results-view.ts` polls every 3 seconds and shows status/stage/findings/provider labels, but has no board, percentage progress, or Markdown download affordance.
- API routes in `apps/api/src/api-contract.mjs` include upload, list documents, create review run, get review run, get findings, and get report artifacts.
- Review lifecycle statuses in `apps/api/src/review-runs/review-run-lifecycle.mjs`: `queued`, `extracting`, `segmenting`, `validating`, `rag_reviewing`, `reporting`, `completed`, `failed`, `cancelled`.
- Worker routes in `services/worker/app/main.py`: `/internal/extract`, `/internal/rules`, `/internal/review`.
- CAG in `services/worker/app/cag_review.py` loads `data/academic-rules/*.txt` into one prompt and parses strict JSON findings.

## confirmed_not_ready_yet

- No Kanban board route/components exist in `apps/web/src/app`.
- No board states `Pending`, `In Review`, `Reviewed`, `Approved` exist as product workflow concepts.
- No priorities `Low`, `Normal`, `Urgent` exist in persistence/API/UI.
- No student detail upload page exists.
- No 20 MB file-size cap exists in web/API upload validation.
- No percent progress contract or UI exists.
- No UI Markdown download link exists, although API report artifacts can return Markdown content.
- No real RAG/vector retrieval implementation exists.
- `normative_segment` / `embedding_record` tables exist, but no repository/service usage, seeding, embedding generation, or similarity query was observed.

## UX_targets

Stitch references:

- Kanban screen: `projects/4881781690617501037/screens/47c992451296411e81adf9fef84f28a1`
- Student detail upload/review screen: `projects/4881781690617501037/screens/233c9e2668c0493bb118ce2787c55b73`
- Technical diagram project created: `projects/3849013438401343765`; screen generation timed out and no screen was listed after polling.

Target state mapping:

- `Pending` → student/submission exists but no active upload/review run has started.
- `In Review` → `queued`, `extracting`, `segmenting`, `validating`, `rag_reviewing`, or `reporting`.
- `Reviewed` → `completed` with report available.
- `Approved` → explicit human approval state; never automatic.

## backend_gaps

- Board/list endpoint needs a real persisted document/run listing; current `GET /api/v1/thesis-documents` returns an empty paginated list.
- Need server and client max upload size: 20 MB.
- Need board-state projection over existing lifecycle statuses.
- Need priority field and persistence.
- Need reviewer assignment and approval semantics if the board is more than a demo projection.
- Need progress percentage/stage contract.
- Need clean artifact download contract for Markdown; current report artifact returns `content` inside JSON.
- Current live review runs synchronously behind a `202` response shape, which limits observable progress.

## data_model_gaps

- `review_run.status` does not model human board approval workflow.
- No `priority` column/table observed.
- No reviewer/approver workflow state observed.
- `report_artifact` table exists, but Markdown artifacts are currently built dynamically in `api-contract.mjs`, not persisted.
- `normative_segment` and `embedding_record` exist in migration, but no seeding, embedding generation, or similarity search was observed.
- `embedding_record.source_class` is constrained to `normative_segment` only.

## proposed_slices

1. **Board read model + UI shell**
   - Add pure web view models that map existing run statuses to board columns.
   - Add a Kanban route with sample-backed or API-backed data depending on available contract.
   - Keep this slice small and testable.
2. **Upload/detail hardening**
   - Add 20 MB PDF/DOCX validation.
   - Add student detail route with upload/dropzone, stage/percent projection, and report summary state.
   - Moving from Pending → In Review occurs when upload/review starts.
3. **Backend board contract**
   - Add persisted listing/query endpoint for board cards.
   - Add priority and board-state projection.
   - Add reviewer assignment only if needed for demo/product acceptance.
4. **Report download UX**
   - Connect detail/results UI to `report-artifacts` and download Markdown as a `.md` file.
5. **Real RAG foundation**
   - Seed normative segments.
   - Add embedding provider abstraction.
   - Store vectors in pgvector.
   - Retrieve relevant institutional/APA/rubric chunks and inject them into review.
   - Keep this as a separate slice unless explicitly accepted as a larger change.

## BDD_scenarios

- Given a PDF/DOCX under 20 MB, when a reviewer uploads it for a pending student, then a review run starts and the student appears in `In Review`.
- Given a selected file is unsupported or over 20 MB, when the reviewer tries to upload it, then upload is blocked before review creation with a clear message.
- Given a run is `queued`, `extracting`, `segmenting`, `validating`, `rag_reviewing`, or `reporting`, when the board loads, then the card appears in `In Review` with stage and percentage.
- Given a run is `completed`, when the board loads, then the card appears in `Reviewed` and the detail page exposes a Markdown report download.
- Given a reviewed item has been read by the human reviewer, when they approve it, then it moves to `Approved`.
- Given embeddings are not configured, when the analysis runs, then the system must not claim semantic RAG retrieval occurred.

## test_strategy

Strict TDD is active in `openspec/config.yaml`.

Primary test runner:

```bash
pnpm test
```

Relevant existing tests:

- Web: `apps/web/tests/upload-validation.test.mjs`, `apps/web/tests/results-view.test.mjs`
- API: `apps/api/tests/contract.test.mjs`, `apps/api/tests/review-run-lifecycle.test.mjs`, `apps/api/tests/review-orchestrator.test.mjs`, `apps/api/tests/review-repository.test.mjs`, `apps/api/tests/live-review-integration.test.mjs`
- Worker: `services/worker/tests/test_extract.py`, `services/worker/tests/test_cag_review.py`, `services/worker/tests/test_rules.py`, `services/worker/tests/test_review_endpoint.py`

Add tests before implementation for:

- board-state projection;
- priority ordering/filtering;
- 20 MB validation;
- percent/stage mapping;
- Markdown download affordance;
- no false RAG claim when embeddings are unavailable.

## risks

- Existing lifecycle status names differ from the desired board language; careless mapping could hide failed/cancelled states.
- Current “RAG” naming is misleading because the implemented path is CAG/full-corpus prompt.
- Inline processing may make progress UI hard to observe unless async behavior is introduced.
- Real RAG/vector work can exceed the 400-line review budget and should be sliced separately from the functional board/upload UX.
- Stitch technical diagram generation timed out; the design artifact should be retried only with user approval or replaced by a repository Mermaid diagram during design.

## next_recommended

Proceed to `sdd-proposal` for `functional-review-board-rag`, with real RAG/vector retrieval marked as a separate later slice unless the user explicitly accepts the larger scope and review workload.

## skill_resolution

paths-injected
