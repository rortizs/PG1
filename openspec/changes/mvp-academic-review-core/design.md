# Technical Design — MVP Academic Review Core

## 1. Design Intent

This design defines the technical foundation for `mvp-academic-review-core`: a manually uploaded thesis review pipeline that prioritizes academic precision, page/chapter traceability, evidence-grounded findings, and auditable reports.

The core design principle is:

> The review engine is a verifiable pipeline first, controlled RAG second, and constrained agentic RAG later. No finding becomes reviewer-visible unless it is backed by thesis evidence and location provenance.

This design implements the accepted stack decision from `openspec/decisions/0001-platform-stack-and-ingestion.md`:

- Angular admin dashboard for MVP UI.
- NestJS + TypeScript for product API and orchestration.
- Python + FastAPI for document, NLP, OCR, RAG, and future agent execution.
- PostgreSQL + pgvector for relational traceability and embeddings.
- Redis + BullMQ for asynchronous job orchestration.
- Local/S3-compatible object storage for source files and generated reports.
- Provider-neutral LLM abstraction for Claude, DeepSeek, and Groq; OpenAI is excluded from the recommended provider set.
- Hermes Desktop is accepted as a reference for provider/model registry UX and streaming progress patterns, not as a runtime dependency.

## 2. Explicit Non-Goals

- No OneDrive, Google Drive, or cloud-drive sync design in this change.
- No OAuth/folder discovery/file-version reconciliation for institutional drives.
- No mobile-first Ionic UI in the MVP.
- No fully autonomous agentic RAG as the initial engine.
- No reviewer-visible findings without evidence text and page/chapter provenance or explicit uncertainty.
- No fabricated GT/APA layout conclusions where extraction cannot support the claim.

## 3. Service Architecture and Boundaries

```text
Angular Admin Dashboard
  -> NestJS REST API
    -> PostgreSQL + pgvector
    -> Object Storage
    -> Redis + BullMQ
      -> Python FastAPI Worker
        -> extraction / OCR / segmentation
        -> deterministic GT/APA/style checks
        -> controlled RAG over normative sources
        -> later constrained agentic reviewers
```

### Angular Admin Dashboard

Responsibilities:

- Upload one thesis file per request.
- Show uploaded document list and details.
- Start a review run.
- Poll or subscribe to review-run status.
- Inspect findings and evidence snippets.
- Download report artifacts.
- In later admin slices, configure provider/model routing and inspect model usage metadata without exposing secrets.

Non-responsibilities:

- It does not parse documents.
- It does not call LLM providers directly.
- It does not expose LLM provider credentials to the browser.
- It does not perform OneDrive authentication or cloud-drive selection.

### NestJS API

Responsibilities:

- Own public `/api/v1` REST contract.
- Authenticate and authorize reviewer actions.
- Validate uploads and persist `thesis_document` metadata.
- Store original files in object storage.
- Create and manage `review_run` lifecycle.
- Enqueue BullMQ jobs and expose status.
- Persist canonical domain records in PostgreSQL.
- Expose findings, evidence, audit events, and report artifacts.
- Enforce evidence guardrails before making findings visible.

Boundary:

- NestJS is the source of truth for product state and API responses.
- It may call the Python worker through internal HTTP or job payload contracts, but persistence of final canonical entities should remain transactionally controlled by the API/domain layer or by worker writes through a narrowly scoped repository contract.

### Python FastAPI Document/AI Worker

Responsibilities:

- Execute long-running document and AI tasks.
- Extract PDF/DOCX text and page metadata.
- Use OCR fallback for scanned PDFs when configured.
- Segment content into pages, sections, chapters, and reviewable text spans.
- Run deterministic and AI-assisted validations.
- Generate embeddings for approved source segments.
- Execute controlled RAG over normative sources.
- In a later phase, execute constrained agentic reviewer modules.
- Return structured outputs that are schema-validatable.

Boundary:

- The worker is not a public user-facing API.
- The worker must not create final reviewer-visible findings unless they pass the evidence contract validator.
- Blocking extraction/OCR libraries must be isolated with worker processes or thread offloading so FastAPI async paths are not blocked.

### PostgreSQL + pgvector

Responsibilities:

- Store normalized core entities and audit trail.
- Preserve traceability from document to review run to finding to evidence.
- Store embeddings for normative source segments and, if needed later, structured thesis segments.

Design rules:

- Use `snake_case` identifiers.
- Prefer `bigint generated always as identity` for internal primary keys.
- Use `uuid` only for opaque public IDs if needed.
- Use `timestamptz` for event time.
- Add explicit indexes for foreign keys.
- Normalize first; use `jsonb` only for optional extraction metadata or provider payloads.

### Redis + BullMQ

Responsibilities:

- Decouple upload/review requests from long-running processing.
- Track job retries, delays, failure reasons, and idempotency keys.
- Coordinate stage-level jobs: extraction, segmentation, validation, RAG review, report generation.

### Object Storage

Responsibilities:

- Store uploaded source files.
- Store generated report artifacts.
- Store optional extracted intermediate files only if needed for audit/debug.

Storage must be referenced by immutable object keys from database records. Do not overwrite report artifacts for a completed run; generate a new artifact record for each format/version.

## 4. End-to-End Data Flow

### 4.1 Upload

1. Reviewer uploads one PDF or DOCX through Angular.
2. NestJS validates file type, size policy, and authenticated access.
3. NestJS writes the source file to object storage.
4. NestJS creates `thesis_document` and initial `audit_event` records.
5. API returns document identity and eligibility to start a review.

### 4.2 Start Review Run

1. Reviewer requests a review run for an uploaded document.
2. NestJS creates `review_run` with status `queued`.
3. NestJS enqueues BullMQ job `review.extract` with document/run identifiers.
4. API returns `202 Accepted` with run status URL.

### 4.3 Extraction and Segmentation

1. BullMQ worker invokes Python extraction path.
2. Worker reads original file from object storage.
3. Worker extracts pages into `document_page` records.
4. Worker detects sections/chapters and persists `document_section` and/or `chapter_span` records.
5. Worker creates segment-level provenance metadata used by evidence snippets.
6. Run status moves through `extracting` and `segmenting`.

If page or chapter provenance is uncertain, the affected record must carry uncertainty metadata. Later findings based on that content must expose the uncertainty.

### 4.4 Deterministic Validation

1. Run status changes to `validating`.
2. Rule modules evaluate extractable evidence:
   - GT structure/format where extractable.
   - APA citations, references, tables, figures where extractable.
   - writing/style checks such as gerunds, muletillas, passive voice, long sentences, spelling, grammar.
   - congruence checks over problem, objectives, conclusions, and recommendations when sections are detectable.
3. Each proposed finding is passed through the evidence guardrail validator.
4. Valid findings and evidence snippets are persisted.
5. Unverifiable checks are persisted as check results or audit events, not as definitive findings.

### 4.5 Controlled RAG

1. Run status changes to `rag_reviewing` when controlled RAG is enabled.
2. Worker retrieves from approved `normative_source` / reference embeddings only.
3. RAG prompts receive:
   - thesis segment evidence;
   - location provenance;
   - retrieved normative excerpts;
   - required structured output schema.
4. Proposed RAG findings must link thesis evidence separately from normative source provenance.
5. Outputs lacking thesis evidence, location, source attribution when claimed, or valid type are rejected/quarantined.

### 4.6 Report Generation

1. Run status changes to `reporting`.
2. Report generator reads only persisted findings, evidence snippets, check results, and run metadata.
3. Markdown report is generated first.
4. Word and XLSX artifacts may be generated after the evidence model stabilizes.
5. `report_artifact` records point to immutable object-storage keys.
6. Run moves to `completed` only when requested artifacts are available or explicitly empty.

### 4.7 Failure and Partial Output

- Any stage may move the run to `failed` with an error summary.
- Partial valid findings may remain persisted but must not be presented as a completed review.
- Partial reports must be explicitly labeled partial and distinguish completed, skipped, failed, and unverifiable checks.

## 5. API Contract Outline

All public routes are versioned under `/api/v1`. REST resources use plural nouns, bounded lists, consistent errors, and pagination where result sets can grow.

### Upload and Documents

```text
POST   /api/v1/thesis-documents
GET    /api/v1/thesis-documents
GET    /api/v1/thesis-documents/{document_id}
```

`POST /thesis-documents`:

- Request: multipart form with exactly one `file` and optional metadata.
- Accepts: PDF, DOCX.
- Rejects: unsupported type with `415` or validation error with `422`.
- Response: `201 Created` with document identity, file metadata, and review eligibility.

### Review Runs

```text
POST   /api/v1/thesis-documents/{document_id}/review-runs
GET    /api/v1/review-runs
GET    /api/v1/review-runs/{run_id}
POST   /api/v1/review-runs/{run_id}/cancel
```

Review run response includes:

- `id`
- `thesis_document_id`
- `status`
- `progress_stage`
- `created_at`, `started_at`, `completed_at`, `failed_at`
- `error_summary` when applicable
- counts for pages, sections, findings, reports when available

Accepted statuses:

- `queued`
- `extracting`
- `segmenting`
- `validating`
- `rag_reviewing`
- `reporting`
- `completed`
- `failed`
- `cancelled`

### Findings and Evidence

```text
GET    /api/v1/review-runs/{run_id}/findings?page=1&page_size=50&type=&severity=
GET    /api/v1/findings/{finding_id}
GET    /api/v1/findings/{finding_id}/evidence
GET    /api/v1/evidence-snippets/{evidence_id}
```

Finding response includes:

- finding type and subtype;
- severity/confidence;
- academic explanation;
- status (`valid`, `rejected`, `quarantined`, `partial` as internal/applicable);
- provenance module (`deterministic_rule`, `ai_assisted`, `controlled_rag`, future `agentic_rag`);
- rule or source reference;
- linked evidence snippets;
- location fields or uncertainty markers.

### Reports

```text
POST   /api/v1/review-runs/{run_id}/report-artifacts
GET    /api/v1/review-runs/{run_id}/report-artifacts
GET    /api/v1/report-artifacts/{artifact_id}
GET    /api/v1/report-artifacts/{artifact_id}/download
```

Report artifact response includes:

- format (`markdown`, later `docx`, `xlsx`);
- generation status;
- associated run ID;
- storage key or signed download URL;
- generated timestamp;
- partial/completed label.

### Normative Sources

Admin/internal MVP routes may be added for indexing approved reference material:

```text
POST   /api/v1/normative-sources
GET    /api/v1/normative-sources
POST   /api/v1/normative-sources/{source_id}/index
```

These routes must never be confused with thesis document uploads.

### Error Format

Use one consistent shape:

```json
{
  "error": "ValidationError",
  "message": "Only PDF and DOCX thesis files are supported.",
  "details": {
    "field": "file",
    "code": "unsupported_file_type"
  },
  "request_id": "...",
  "timestamp": "..."
}
```

## 6. Core Data Model

The model below is conceptual, not migration-ready SQL. It defines ownership, required relationships, and indexing expectations.

### `thesis_document`

Represents a manually uploaded thesis source.

Key fields:

- `id bigint primary key`
- optional `public_id uuid unique`
- `original_filename text not null`
- `content_type text not null`
- `file_size_bytes bigint not null`
- `storage_key text not null unique`
- `sha256 text not null`
- `upload_status text not null`
- `uploaded_by_user_id bigint not null`
- `created_at timestamptz not null`

Indexes:

- `uploaded_by_user_id`
- `created_at`
- `sha256` if duplicate detection is needed.

### `review_run`

Represents one attempt to review a document.

Key fields:

- `id bigint primary key`
- `thesis_document_id bigint not null references thesis_document(id)`
- `status text not null check (...)`
- `pipeline_version text not null`
- `requested_outputs text[] not null default array['markdown']`
- `error_summary text`
- `started_at timestamptz`
- `completed_at timestamptz`
- `failed_at timestamptz`
- `created_at timestamptz not null`

Indexes:

- `thesis_document_id`
- `status`
- `(thesis_document_id, created_at)`

### `document_page`

Represents extracted page-level content.

Key fields:

- `id bigint primary key`
- `thesis_document_id bigint not null references thesis_document(id)`
- `review_run_id bigint not null references review_run(id)`
- `page_number bigint`
- `text_content text not null`
- `extraction_method text not null` (`pdf_text`, `docx`, `ocr`)
- `provenance_confidence double precision`
- `is_page_number_uncertain boolean not null default false`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null`

Indexes:

- `thesis_document_id`
- `review_run_id`
- `(review_run_id, page_number)`

### `document_section` / `chapter_span`

Use `document_section` as the general structure table and allow `section_type = 'chapter'` for chapter spans. A compatibility view or alias named `chapter_span` can be introduced if preferred by implementation.

Key fields:

- `id bigint primary key`
- `review_run_id bigint not null references review_run(id)`
- `parent_section_id bigint references document_section(id)`
- `section_type text not null` (`chapter`, `section`, `subsection`, `references`, `appendix`, etc.)
- `title text`
- `normalized_title text`
- `start_page_number bigint`
- `end_page_number bigint`
- `start_offset bigint`
- `end_offset bigint`
- `is_location_uncertain boolean not null default false`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null`

Indexes:

- `review_run_id`
- `parent_section_id`
- `(review_run_id, section_type)`
- `(review_run_id, start_page_number)`

### `evidence_snippet`

Stores exact thesis evidence used by findings.

Key fields:

- `id bigint primary key`
- `review_run_id bigint not null references review_run(id)`
- `document_page_id bigint references document_page(id)`
- `document_section_id bigint references document_section(id)`
- `evidence_text text not null`
- `context_before text`
- `context_after text`
- `page_number bigint`
- `chapter_or_section_title text`
- `start_offset bigint`
- `end_offset bigint`
- `is_page_uncertain boolean not null default false`
- `is_section_uncertain boolean not null default false`
- `created_at timestamptz not null`

Constraints/guardrails:

- `evidence_text` must not be empty.
- At least one location path must exist: page, section, linked page/section, or explicit uncertainty marker.

Indexes:

- `review_run_id`
- `document_page_id`
- `document_section_id`

### `finding`

Represents a validated or quarantined academic observation.

Key fields:

- `id bigint primary key`
- `review_run_id bigint not null references review_run(id)`
- `finding_type text not null` (`gt`, `apa`, `writing_style`, `grammar`, `congruence`, `methodology`, etc.)
- `finding_subtype text`
- `severity text not null`
- `confidence double precision`
- `title text not null`
- `explanation text not null`
- `recommendation text`
- `producer_type text not null` (`deterministic_rule`, `ai_assisted`, `controlled_rag`, future `agentic_rag`)
- `producer_id text not null`
- `rule_id text`
- `normative_source_id bigint references normative_source(id)`
- `status text not null` (`valid`, `rejected`, `quarantined`, `partial`)
- `rejection_reason text`
- `created_at timestamptz not null`

Indexes:

- `review_run_id`
- `(review_run_id, finding_type)`
- `(review_run_id, severity)`
- `normative_source_id`

### `finding_evidence`

Join table allowing one finding to cite one or many evidence snippets. Congruence findings often need evidence from multiple sections.

Key fields:

- `finding_id bigint not null references finding(id)`
- `evidence_snippet_id bigint not null references evidence_snippet(id)`
- `role text not null default 'primary'`
- primary key `(finding_id, evidence_snippet_id)`

Indexes:

- `evidence_snippet_id`

### `report_artifact`

Represents generated output for a review run.

Key fields:

- `id bigint primary key`
- `review_run_id bigint not null references review_run(id)`
- `format text not null` (`markdown`, later `docx`, `xlsx`)
- `status text not null` (`queued`, `generating`, `available`, `failed`)
- `storage_key text`
- `content_type text`
- `file_size_bytes bigint`
- `is_partial boolean not null default false`
- `generation_version text not null`
- `error_summary text`
- `created_at timestamptz not null`
- `generated_at timestamptz`

Indexes:

- `review_run_id`
- `(review_run_id, format)`

### `normative_source`

Represents approved GT/APA/reference material.

Key fields:

- `id bigint primary key`
- `source_type text not null` (`gt_guide`, `apa_6`, `rubric`, `example_observation`)
- `title text not null`
- `version_label text`
- `storage_key text`
- `is_approved boolean not null default false`
- `created_at timestamptz not null`

Indexes:

- `(source_type, is_approved)`

### `normative_segment`

Represents retrievable reference chunks.

Key fields:

- `id bigint primary key`
- `normative_source_id bigint not null references normative_source(id)`
- `segment_text text not null`
- `section_title text`
- `page_number bigint`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null`

Indexes:

- `normative_source_id`

### `embedding_record`

Stores vector records for approved retrieval targets.

Key fields:

- `id bigint primary key`
- `source_class text not null` (`normative_segment`, later `document_segment` if enabled)
- `source_id bigint not null`
- `embedding_model text not null`
- `embedding vector(...) not null`
- `content_hash text not null`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null`

Indexes:

- `(source_class, source_id)`
- vector similarity index appropriate to pgvector operator class after model dimension is chosen.

Guardrail:

- Controlled RAG queries must filter `source_class = 'normative_segment'` unless a future design explicitly enables thesis-segment retrieval.

### `audit_event`

Append-only event log for important user and pipeline actions.

Key fields:

- `id bigint primary key`
- `actor_user_id bigint`
- `entity_type text not null`
- `entity_id bigint`
- `event_type text not null`
- `message text`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null`

Indexes:

- `(entity_type, entity_id)`
- `actor_user_id`
- `created_at`

## 7. Queue and Job Flow

BullMQ queues should be stage-oriented and idempotent by `review_run_id` + stage.

### Queues

- `review.extract`
- `review.segment`
- `review.validate`
- `review.rag`
- `review.report`

A single queue with named jobs is acceptable for MVP if simpler, but stage names must remain visible in job metadata and audit events.

### Job Payload Shape

```json
{
  "review_run_id": 123,
  "thesis_document_id": 456,
  "pipeline_version": "mvp-001",
  "requested_outputs": ["markdown"],
  "idempotency_key": "review_run:123:extract:mvp-001"
}
```

### Flow

1. `review.extract`
   - set run `extracting`;
   - invoke Python extraction;
   - persist pages;
   - enqueue `review.segment`.
2. `review.segment`
   - set run `segmenting`;
   - detect sections/chapters;
   - persist section spans;
   - enqueue `review.validate`.
3. `review.validate`
   - set run `validating`;
   - execute deterministic checks;
   - persist valid findings and check outcomes;
   - enqueue `review.rag` if controlled RAG enabled, otherwise `review.report`.
4. `review.rag`
   - set run `rag_reviewing`;
   - retrieve normative references;
   - validate structured AI outputs;
   - persist valid/quarantined/rejected outputs;
   - enqueue `review.report`.
5. `review.report`
   - set run `reporting`;
   - generate artifacts;
   - mark run `completed` or `failed`.

### Reliability Rules

- Jobs must be retryable without duplicating pages, sections, findings, or reports.
- Use idempotency keys and uniqueness constraints where practical.
- Status transitions must be monotonic except cancellation/failure handling.
- Failed jobs must write `audit_event` and `review_run.error_summary`.
- Cancellation should prevent future stages from starting and mark queued/running artifacts appropriately.

### Python Async Guidance

- Use async HTTP/database clients where the worker performs I/O.
- Do not block the FastAPI event loop with OCR/PDF CPU-heavy work; use `asyncio.to_thread()`, process pools, or dedicated worker processes.
- Limit outbound LLM/embedding concurrency with semaphores.
- Apply timeouts to external provider calls.
- Preserve cancellation behavior and cleanup temporary files.

## 8. Controlled RAG Phase

Controlled RAG is allowed only over approved normative material in this change.

### Inputs

- Structured thesis evidence segment.
- Page/chapter provenance.
- Validation objective, e.g. APA citation check or GT structure check.
- Retrieved `normative_segment` records from approved sources.

### Retrieval Constraints

- Filter by `normative_source.is_approved = true`.
- Filter embedding records by `source_class = 'normative_segment'`.
- Keep reference retrieval separate from thesis evidence.
- If no relevant source passes threshold, the finding must not cite fabricated normative support.

### Output Contract

RAG modules must return structured proposals including:

- finding type/subtype;
- explanation;
- recommendation;
- evidence snippet IDs or exact evidence text with source segment/page;
- normative source/segment IDs when used;
- confidence;
- producer ID/model metadata.

### Validator

Before persistence as valid:

- evidence text must match or be derivable from extracted thesis text;
- evidence must include page/chapter provenance or uncertainty marker;
- finding type must be allowed;
- normative source claim must point to an approved source;
- confidence must be within valid range;
- unsupported outputs are rejected or quarantined and audited.

## 9. Agentic RAG Phase

Agentic RAG is a later phase, not part of the initial engine. It may be introduced only after extraction, evidence tracking, deterministic validations, and controlled RAG are reliable.

### Allowed Agent Modules

- APA reviewer.
- GT reviewer.
- Writing/style reviewer.
- Methodology reviewer.
- Congruence reviewer.
- Report synthesizer.
- Evidence auditor.

### Constraints

- Agents can only operate on structured document pages/sections/evidence and approved normative records.
- Agents may plan tool calls, but every final finding must satisfy the same evidence contract.
- Agents cannot create new source truth; they can only propose findings for validation.
- Agent output that cannot link to thesis evidence is rejected or quarantined.
- Agentic findings must expose `producer_type = 'agentic_rag'`, module identity, model/provider metadata, retrieved source references, and evidence links.

### Agentic Guardrail Pattern

```text
agent plan -> tool retrieval -> proposed structured finding -> evidence validator -> persistence as valid/quarantined/rejected
```

The evidence validator remains outside the agent and is authoritative.

## 10. Strict Evidence Guardrails

A finding is reviewer-visible only when all of the following are true:

1. It belongs to a `review_run`.
2. It has a valid `finding_type`.
3. It has at least one linked `evidence_snippet`.
4. Each required evidence snippet has non-empty thesis text.
5. Evidence has page provenance or explicit page uncertainty.
6. Evidence has chapter/section provenance or explicit section uncertainty.
7. It identifies producer type and producer ID.
8. If it cites GT/APA/RAG normative support, that source exists and is approved.
9. Confidence/severity is present.
10. It is not marked `rejected` or `quarantined`.

Unverifiable checks must be represented as incomplete/unverifiable check results or audit events, not definitive academic findings.

## 11. Testing Strategy

Strict TDD is active for implementation. Current OpenSpec config contains a placeholder command (`pytest -q`) because scaffolding does not exist yet. The first implementation slice must replace this with component-specific commands, for example:

- NestJS API: `npm test`, `npm run test:e2e`, or equivalent.
- Python worker: `pytest -q` with `pytest-asyncio` where needed.
- Frontend: Angular unit/component tests once UI scaffolding exists.

### Test Categories

#### API Contract Tests

- Upload accepts one PDF/DOCX and rejects unsupported types.
- Review-run creation returns `202` and status URL.
- Status responses expose required lifecycle fields.
- Findings endpoints paginate and include evidence/provenance.
- Error responses use the standard shape.

#### Data Model Tests

- Required constraints reject empty evidence text.
- Findings cannot become valid without linked evidence.
- Foreign key relationships preserve document → run → finding → evidence traceability.
- Embedding records separate normative and thesis source classes.

#### Queue/Job Tests

- Starting a review enqueues the extraction stage.
- Each stage updates status and enqueues the next stage.
- Retries are idempotent.
- Failures set `failed` status and write audit events.
- Cancellation prevents later stages from running.

#### Worker Tests

- PDF/DOCX extraction preserves page provenance where possible.
- OCR/scanned inputs mark uncertainty when appropriate.
- Section/chapter detection records uncertainty instead of fabricating location.
- Async worker code avoids unbounded concurrency and handles provider timeouts.

#### Validation Tests

- GT/APA/style findings require exact evidence.
- Visual-only GT/APA checks become unverifiable when extraction is insufficient.
- Congruence findings require evidence from each compared section.
- AI/RAG outputs without evidence are rejected or quarantined.

#### RAG Tests

- Retrieval only uses approved normative sources.
- Reference segments are never treated as thesis evidence.
- Missing retrieval support does not fabricate citations.
- RAG proposal schema validation is enforced before persistence.

#### Report Tests

- Markdown reports include document identity, run identity, finding type, evidence, page/chapter or uncertainty, confidence/severity, and provenance.
- Empty reports do not invent observations.
- Partial reports are clearly labeled.
- Report artifacts are tied to the correct review run.

## 12. Review Workload Split Guidance

Implementation should be split into review units near or below the configured 400 changed-line budget. Suggested slices:

1. Project scaffold and test-runner replacement.
2. PostgreSQL migrations for core document/run/page/section entities.
3. Upload API and object storage abstraction.
4. Review-run lifecycle API and BullMQ setup.
5. Python worker extraction contract stub with tests.
6. Page/section persistence and uncertainty metadata.
7. Evidence/finding schema and guardrail validator.
8. Deterministic writing/style checks.
9. GT rule-check framework.
10. APA rule-check framework.
11. Congruence check framework.
12. Normative source ingestion and embedding records.
13. Controlled RAG retrieval and output validation.
14. Markdown report generation.
15. Word report generation, if still in scope.
16. XLSX matrix generation, if still in scope.
17. Agentic RAG framework only after controlled RAG is stable.

Each slice should include tests first, implementation second, and verification evidence in the apply/verify artifacts.

## 13. Rollout and Operational Notes

- Start with local object storage and local PostgreSQL/Redis for development.
- Use seeded normative sources for GT and APA before enabling RAG-backed findings.
- Keep AI provider credentials behind server-side configuration only.
- Store model/provider metadata on AI-assisted findings for auditability.
- Prefer Markdown as the first report artifact to stabilize evidence formatting before DOCX/XLSX.
- Defer OneDrive until a future change proves the review engine is reliable.

## 14. Open Follow-Up for Tasks Phase

The tasks phase should convert this design into strict TDD implementation units and explicitly decide the initial scaffolding layout, package manager, migration tooling, and component-specific test commands.
