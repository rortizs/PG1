# Implementation Tasks — MVP Academic Review Core

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 2,500–4,500 across scaffold, API, worker, schema, tests, and reports |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 scaffold/tests → PR 2 API+DB core → PR 3 upload/storage → PR 4 worker extraction → PR 5 evidence/rules → PR 6 controlled RAG → PR 7 reports → PR 8 agentic milestone scaffold |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

## Scope Guard

- OneDrive, Google Drive, and cloud-drive sync are out of scope for this change.
- MVP ingestion is one-to-one manual upload of PDF/DOCX thesis files only.
- Strict TDD applies: each implementation slice starts with failing tests, then minimal implementation, triangulation, and refactor.
- Markdown is the first report format; DOCX/XLSX remain separate follow-up slices unless explicitly pulled into scope.

## Work Units

### 1. Repo scaffolding and strict TDD commands

- [x] RED: Add placeholder failing smoke tests for intended packages:
  - `apps/api/` NestJS API test target.
  - `apps/web/` Angular admin test target.
  - `services/worker/` FastAPI/Python test target.
- [x] GREEN: Scaffold monorepo directories and package/tooling files with minimal passing smoke tests:
  - `package.json`, `pnpm-workspace.yaml` or chosen package-manager workspace file.
  - `apps/api/`, `apps/web/`, `services/worker/`, `infra/`, `docs/`.
- [x] TRIANGULATE: Add root verification commands that run all component tests without relying on the current placeholder `pytest -q`.
- [x] REFACTOR: Update `openspec/config.yaml` `sdd.test_runner.command` with real commands, e.g. `pnpm test && cd services/worker && pytest -q`.
- [x] Verify: root test command passes locally; no production feature code beyond scaffolding.
- [ ] Rollback: remove scaffold directories and restore `openspec/config.yaml` placeholder.

### 2. API contract and OpenAPI baseline

- [x] RED: Write API contract tests for versioned resource routes and standard error shape:
  - `POST /api/v1/thesis-documents`
  - `GET /api/v1/thesis-documents`
  - `POST /api/v1/thesis-documents/{document_id}/review-runs`
  - `GET /api/v1/review-runs/{run_id}`
  - `GET /api/v1/review-runs/{run_id}/findings`
  - `GET /api/v1/review-runs/{run_id}/report-artifacts`
- [x] GREEN: Implement minimal NestJS controllers/modules under `apps/api/src/` returning contract-valid stub responses and consistent `{ error, message, details, request_id, timestamp }` errors.
- [x] TRIANGULATE: Add pagination/filter contract cases for findings list and document list.
- [x] REFACTOR: Generate or document OpenAPI at `docs/api/openapi.yaml` or `apps/api/openapi.yaml`.
- [x] Verify: API tests prove resource nouns, `/api/v1` versioning, bounded lists, and error format.
- [ ] Rollback: remove API module and OpenAPI file without touching DB migrations.

### 3. PostgreSQL schema and migration baseline

- [x] RED: Add migration/schema tests for required constraints, FK indexes, and status checks using selected NestJS migration tool.
- [x] GREEN: Create migrations under `apps/api/src/db/migrations/` for:
  - `thesis_document`
  - `review_run`
  - `document_page`
  - `document_section`
  - `evidence_snippet`
  - `finding`
  - `finding_evidence`
  - `report_artifact`
  - `normative_source`
  - `normative_segment`
  - `embedding_record`
  - `audit_event`
- [x] TRIANGULATE: Add explicit FK indexes, `timestamptz`, `snake_case`, normalized relations, and `pgvector` extension setup.
- [x] REFACTOR: Keep optional/semi-structured data in constrained `jsonb` metadata columns only.
- [x] Verify: static migration tests cover up/down SQL structure, non-empty evidence, invalid status checks, and FK indexes; no live PostgreSQL connection was available/required for this slice.
- [ ] Rollback: migration down restores prior empty DB state.

### 4. Upload and object storage abstraction

- [x] RED: Add API tests for PDF/DOCX accepted, unsupported types rejected, exactly one file required, and no review run created on rejection.
- [x] GREEN: Implement `apps/api/src/thesis-documents/` upload endpoint with local/S3-compatible storage interface in `apps/api/src/storage/`.
- [x] TRIANGULATE: Persist `thesis_document` metadata: filename, content type, size, storage key, SHA-256, uploader, upload status.
- [x] REFACTOR: Isolate storage adapter config so local dev and S3-compatible deployments share one interface.
- [x] Verify: upload flow stores source artifact and creates DB record; unsupported files return `415`/`422` with standard error.
- [ ] Rollback: delete uploaded test objects and records; storage adapter can be disabled independently.

### 5. Review-run lifecycle and BullMQ orchestration

- [x] RED: Add tests for review-run creation returning `202`, status transitions, cancellation, failure summary, and extraction job enqueue.
- [x] GREEN: Implement `apps/api/src/review-runs/` service/controller and BullMQ queue wiring under `apps/api/src/jobs/`.
- [x] TRIANGULATE: Add idempotency key format `review_run:{id}:{stage}:{pipeline_version}` and audit events for lifecycle changes.
- [x] REFACTOR: Centralize allowed statuses: `queued`, `extracting`, `segmenting`, `validating`, `rag_reviewing`, `reporting`, `completed`, `failed`, `cancelled`.
- [x] Verify: repeated job starts do not duplicate runs/jobs; failed jobs set `review_run.error_summary`.
- [ ] Rollback: disable queue module while preserving uploaded documents.

### 6. Worker parser pipeline contract

- [ ] RED: Add Python tests in `services/worker/tests/` for worker request/response schemas, PDF/DOCX parser stubs, page provenance, and uncertainty flags.
- [ ] GREEN: Implement FastAPI worker endpoints/internal handlers under `services/worker/app/` for extraction and segmentation contracts.
- [ ] TRIANGULATE: Add parser adapters for concrete discovery targets:
  - PDF text extraction library selection.
  - DOCX extraction library selection.
  - OCR fallback strategy and when to mark uncertainty.
- [ ] REFACTOR: Keep blocking PDF/OCR work outside the FastAPI event loop via thread/process offload.
- [ ] Verify: worker tests pass and sample extraction response includes pages, sections, offsets, confidence, and uncertainty metadata.
- [ ] Rollback: API can keep review runs queued/failed without worker availability.

### 7. Page/section persistence integration

- [ ] RED: Add integration tests proving worker extraction output persists to `document_page` and `document_section` without losing run/document linkage.
- [ ] GREEN: Implement API-side repository/import path for extraction results.
- [ ] TRIANGULATE: Cover uncertain page/chapter cases and ensure uncertainty propagates to downstream evidence candidates.
- [ ] REFACTOR: Normalize `document_section` with `section_type = 'chapter'` rather than separate duplicated tables unless implementation proves otherwise.
- [ ] Verify: extracted pages can be queried by `review_run_id` and sections by type/start page.
- [ ] Rollback: delete run-specific pages/sections and rerun extraction.

### 8. Evidence and finding contract validator

- [ ] RED: Add tests that reject valid-status findings without evidence text, page/section provenance or uncertainty, allowed type, producer, confidence/severity, and approved normative source when cited.
- [ ] GREEN: Implement validator under `apps/api/src/findings/` or shared domain package used before persistence.
- [ ] TRIANGULATE: Add join persistence through `finding_evidence` for multi-evidence findings such as congruence checks.
- [ ] REFACTOR: Separate statuses `valid`, `rejected`, `quarantined`, and `partial`; never expose rejected/quarantined as final observations.
- [ ] Verify: `GET /findings` returns only reviewer-visible valid/partial outputs with linked evidence.
- [ ] Rollback: validator can be tightened without data loss; invalid findings remain quarantined/rejected.

### 9. Rule engine MVP — writing/style first

- [ ] RED: Add tests for gerunds, muletillas/filler words, long sentences, passive voice placeholder, spelling/grammar placeholder, and exact evidence extraction.
- [ ] GREEN: Implement rule registry and first deterministic writing/style rules under `services/worker/app/rules/`.
- [ ] TRIANGULATE: Add rule IDs, severity/confidence defaults, and academic explanation text suitable for reports.
- [ ] REFACTOR: Keep language-specific rule config in `services/worker/app/rules/config/`.
- [ ] Verify: every produced writing finding passes evidence validator and links to page/section context.
- [ ] Rollback: disable individual rule IDs through config.

### 10. Rule engine MVP — GT and APA frameworks

- [ ] RED: Add tests for GT structure/check-unverifiable behavior and APA citation/reference consistency cases.
- [ ] GREEN: Implement initial GT and APA rule modules under `services/worker/app/rules/gt/` and `services/worker/app/rules/apa/`.
- [ ] TRIANGULATE: Add `check_result` or audit representation for visual/layout rules that cannot be verified from extraction.
- [ ] REFACTOR: Ensure visual GT/APA uncertainty never becomes a definitive finding without evidence.
- [ ] Verify: GT/APA findings include rule provenance and thesis evidence; unverifiable checks are marked incomplete/uncertain.
- [ ] Rollback: disable GT/APA rule families independently from writing rules.

### 11. Congruence validation framework

- [ ] RED: Add tests requiring evidence from both compared sections for objective/conclusion/recommendation findings.
- [ ] GREEN: Implement section discovery and comparison scaffolding for problem, objectives, conclusions, and recommendations.
- [ ] TRIANGULATE: Mark congruence checks incomplete when required sections are missing.
- [ ] REFACTOR: Keep AI-assisted congruence prompts behind the same structured output validator if used.
- [ ] Verify: no congruence finding appears with single-sided evidence only.
- [ ] Rollback: disable congruence module without affecting deterministic style/APA/GT rules.

### 12. Controlled RAG normative sources

- [ ] RED: Add tests for approved-only normative retrieval, reference/thesis separation, missing-source behavior, and structured AI output rejection.
- [ ] GREEN: Implement normative source ingestion/indexing routes and worker embedding path:
  - `POST /api/v1/normative-sources`
  - `POST /api/v1/normative-sources/{source_id}/index`
  - `normative_source`, `normative_segment`, `embedding_record` writes.
- [ ] TRIANGULATE: Enforce `embedding_record.source_class = 'normative_segment'` for controlled RAG retrieval.
- [ ] REFACTOR: Add provider-neutral LLM abstraction for Claude, DeepSeek, and Groq embeddings/LLM calls with model metadata; keep OpenAI out of the recommended implementation path.
- [ ] TRIANGULATE: Add backend-owned provider/model registry seed data and routing policy metadata inspired by Hermes Desktop patterns, without exposing provider credentials to the Angular app.
- [ ] Verify: RAG-supported findings link thesis evidence separately from approved normative source/segment IDs.
- [ ] Rollback: disable RAG queue stage and preserve indexed sources for later reuse.

### 13. Report generation MVP — Markdown

- [ ] RED: Add tests for completed, empty, pending, stale-run, and partial Markdown report scenarios.
- [ ] GREEN: Implement Markdown generator using only persisted findings/evidence/check results under `apps/api/src/report-artifacts/` or worker report module.
- [ ] TRIANGULATE: Include document identity, run identity, finding type, evidence, page/chapter or uncertainty, confidence/severity, and provenance.
- [ ] REFACTOR: Store immutable report artifacts through storage abstraction and `report_artifact` records.
- [ ] Verify: empty reports state no valid findings and never invent observations.
- [ ] Rollback: delete generated artifact records/objects; persisted findings remain unchanged.

### 14. Report generation later slices — DOCX and XLSX

- [ ] RED: Add contract tests proving DOCX and XLSX preserve all Markdown-required evidence fields.
- [ ] GREEN: Implement DOCX generation as a separate review unit after Markdown stabilizes.
- [ ] GREEN: Implement XLSX matrix generation as another separate review unit after DOCX or independently.
- [ ] TRIANGULATE: Ensure each XLSX row includes finding type, page/chapter or uncertainty, evidence reference, and provenance.
- [ ] REFACTOR: Share report view-model creation across Markdown/DOCX/XLSX.
- [ ] Verify: generated formats are tied to the correct `review_run_id` and never mix runs.
- [ ] Rollback: disable optional formats while Markdown remains available.

### 15. Agentic RAG later milestone scaffold

- [ ] RED: Add tests proving agentic outputs cannot bypass the evidence validator and unsupported outputs are rejected/quarantined.
- [ ] GREEN: Add disabled-by-default agent module interfaces for APA, GT, writing/style, methodology, congruence, report synthesizer, and evidence auditor.
- [ ] TRIANGULATE: Ensure agents operate only on structured document pages/sections/evidence and approved normative records.
- [ ] REFACTOR: Keep authoritative validation outside the agent: `agent plan → tool retrieval → proposed finding → evidence validator → persistence`.
- [ ] Verify: setting agentic feature flag off leaves controlled RAG behavior unchanged.
- [ ] Rollback: remove/disable agentic feature flag and module registrations.

### 16. Final verification and documentation

- [ ] RED: Add end-to-end failing test for upload → review run → extraction stub → validation → Markdown report.
- [ ] GREEN: Wire the minimal happy path across API, queue, worker, DB, and storage.
- [ ] TRIANGULATE: Add failure-path E2E coverage for unsupported upload, extraction failure, RAG rejection, and partial report labeling.
- [ ] REFACTOR: Update `README.md`, `openspec/README.md`, and `docs/` with setup, test, and local service commands.
- [ ] Verify: root verification command, API tests, worker tests, and any frontend smoke tests pass from a clean checkout.
- [ ] Rollback: keep migration rollback and storage cleanup instructions documented.

## Suggested PR Chain

1. **PR 1 — Scaffold and tests**: Work unit 1 only.
2. **PR 2 — API contract and DB schema**: Work units 2–3.
3. **PR 3 — Upload, storage, and review lifecycle**: Work units 4–5.
4. **PR 4 — Worker extraction and persistence**: Work units 6–7.
5. **PR 5 — Evidence contract and deterministic rules**: Work units 8–11, split further if over budget.
6. **PR 6 — Controlled RAG**: Work unit 12.
7. **PR 7 — Markdown report MVP**: Work unit 13.
8. **PR 8+ — Optional reports, provider admin, and agentic RAG milestone**: Work units 14–15 plus a later provider/model routing admin slice if needed.
9. **Final verification PR or slice**: Work unit 16 when full happy path exists.
