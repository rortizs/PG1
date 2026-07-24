# Change Proposal — MVP Academic Review Core

## Change Name

`mvp-academic-review-core`

## Intent

Build the MVP foundation for an AI-assisted university thesis review platform focused on academic precision, evidence traceability, and auditable findings.

The MVP should support one-to-one upload of thesis documents, structured extraction of PDF/DOCX content, deterministic and AI-assisted academic validations, controlled RAG over GT/APA reference materials, and a later path toward agentic RAG. OneDrive integration is explicitly out of scope for this change.

## Background

Project history establishes that every generated observation must include:

- chapter or section;
- exact page;
- evidence text;
- error/finding type.

The platform must never generate generic findings or findings without evidence. It should behave like an academic thesis reviewer, methodology advisor, style corrector, APA/GT validator, and congruence auditor.

Accepted platform decision: `openspec/decisions/0001-platform-stack-and-ingestion.md`.

## Scope

### In Scope

- Angular admin dashboard planning for MVP document upload and review status views.
- NestJS + TypeScript API planning for document upload, review orchestration, report access, audit events, and REST contracts.
- Python FastAPI document/AI worker planning for PDF/DOCX parsing, OCR fallback, document segmentation, validations, controlled RAG, and later agentic RAG modules.
- PostgreSQL + pgvector data model planning for documents, review runs, chapter spans, findings, evidence snippets, generated reports, audit events, and embedding records.
- Redis + BullMQ job orchestration planning for asynchronous review processing.
- Local/S3-compatible object storage planning for uploaded source files and generated report artifacts.
- Provider-neutral LLM abstraction planning for Claude, DeepSeek, Groq, embeddings, and future agent execution; OpenAI is excluded from the recommended provider set.
- Backend-owned provider/model registry planning inspired by Hermes Desktop patterns, without taking Hermes as a runtime dependency.
- Controlled RAG over institutional references such as GT guide and APA 6.
- Future agentic RAG roadmap using specialized reviewers only after structured parsing and evidence tracking are reliable.
- Strict TDD planning: tests must be specified before implementation and test commands must be made component-specific once scaffolding exists.

### Out of Scope

- OneDrive, Google Drive, or institutional cloud-drive sync.
- Mobile-first Ionic implementation for MVP.
- Fully autonomous agentic review as the initial review engine.
- Plagiarism-detection implementation beyond recording the project rule that acceptable plagiarism threshold is 20%.
- Production deployment automation.
- Multi-tenant institutional administration beyond what is necessary to avoid blocking MVP data design.
- Direct insertion of comments into DOCX as an MVP must-have; it remains a later enhancement unless promoted by a future change.

## Affected Areas

### Frontend

- Admin dashboard navigation.
- One-to-one thesis upload flow.
- Future provider/model routing admin inspired by Hermes Desktop, scoped behind backend credential controls.
- Review run list/detail views.
- Finding/evidence inspection views.
- Report download views.

### API

- Versioned REST API design under `/api/v1`.
- Upload endpoints for PDF/DOCX documents.
- Review-run creation and status endpoints.
- Finding and evidence retrieval endpoints.
- Report artifact endpoints.
- Consistent error format, pagination, filtering, and audit-safe status transitions.

### Document Processing

- PDF text extraction with page tracking.
- OCR fallback for scanned PDFs.
- DOCX text extraction and structural metadata capture.
- Chapter/section detection.
- Table, figure, citation, and reference extraction where feasible.
- Text segmentation preserving page/chapter provenance.

### Academic Validation

- GT guide checks: structure, margins, font, interline spacing, impersonal style, justification, numbering, chapter starts, and formal thesis structure.
- APA 6 checks: citations, references, tables, figures, hanging indent, and formatting rules.
- Writing checks: gerunds, filler words, passive voice, long sentences, spelling, grammar, and style problems.
- Congruence checks: problem, objectives, conclusions, and recommendations alignment.

### RAG and AI

- Controlled RAG over GT/APA/reference material with source attribution.
- Embedding records linked to source segments.
- Prompt contracts requiring evidence-grounded findings.
- Later agentic RAG modules for APA, GT, writing, methodology, congruence, report generation, and evidence auditing.

### Data Model

Candidate core entities:

- `thesis_document`
- `document_file`
- `review_run`
- `document_page`
- `chapter_span`
- `document_segment`
- `finding`
- `evidence_snippet`
- `report_artifact`
- `audit_event`
- `embedding_record`
- `reference_document`
- `reference_segment`

PostgreSQL design should use snake_case names, `timestamptz`, explicit foreign-key indexes, normalized relations first, and pgvector only where embeddings are required.

## Proposed Architecture Direction

```text
Angular Admin Dashboard
  -> NestJS REST API
    -> PostgreSQL + pgvector
    -> Local/S3-compatible object storage
    -> Redis + BullMQ jobs
      -> Python FastAPI Document/AI Worker
        -> PDF/DOCX/OCR extraction
        -> structure + evidence model
        -> GT/APA/rules validations
        -> controlled RAG
        -> later agentic RAG reviewers
```

The core review engine must be a verifiable pipeline, not an opaque autonomous agent. Agentic RAG may be introduced only as specialized modules that consume structured document spans and produce evidence-linked findings.

## Success Criteria

- Proposal/spec/design/tasks artifacts define an MVP that can process a manually uploaded PDF/DOCX thesis without OneDrive.
- Every planned finding model requires chapter/section, page, evidence text, finding type, confidence, and rule/source provenance.
- API planning includes upload, review start/status, findings, evidence, and report access.
- Data planning supports relational traceability from document to review run to finding to evidence snippet.
- RAG planning separates institutional reference retrieval from thesis-document segmentation.
- Agentic RAG is documented as a later stage after deterministic extraction, evidence tracking, and controlled RAG are reliable.
- Strict TDD requirements are captured before implementation.
- Future implementation can be split into review units near or below the 400-line review budget.

## Risks

- PDF/DOCX extraction may lose layout, page boundaries, or chapter context, weakening evidence traceability.
- Scanned PDFs may require OCR with lower accuracy and higher processing time.
- AI-generated findings may hallucinate unless prompts, schemas, validators, and evidence requirements are strict.
- APA/GT rules may include visual formatting checks that are difficult to validate from extracted text alone.
- Maintaining NestJS and Python services introduces cross-service contract and deployment complexity.
- pgvector is pragmatic for MVP but may need augmentation if retrieval scale or hybrid search needs grow.
- Report generation in Word/XLSX can expand scope if attempted before the finding/evidence model is stable.

## Risk Mitigations

- Treat extraction provenance as a first-class domain model: page, chapter, segment, offsets, and source file metadata.
- Reject or flag findings that lack evidence or location.
- Keep deterministic rules and AI-assisted checks separate in the data model.
- Use structured LLM outputs validated against schemas before persistence.
- Start with Markdown reports before Word/XLSX if implementation scope becomes too large.
- Keep OneDrive deferred until the core review engine is proven reliable.

## Rollback Plan

Because this change is currently planning-only, rollback means removing or superseding the change directory:

- remove `openspec/changes/mvp-academic-review-core/`; or
- create a successor proposal that narrows the MVP to document upload + extraction only.

For future implementation phases, rollback should preserve uploaded source files and audit events while allowing review runs, findings, embeddings, and generated artifacts from a failed pipeline version to be invalidated or reprocessed.

## Acceptance Gate for Next Phase

Proceed to spec/design only after confirming:

- one-to-one upload remains the MVP ingestion path;
- OneDrive remains out of scope;
- Angular admin, NestJS API, Python FastAPI worker, PostgreSQL+pgvector, Redis+BullMQ, S3-compatible storage, and provider-neutral Claude/DeepSeek/Groq abstraction remain accepted;
- strict TDD remains required for implementation;
- Markdown report can be the first report artifact if Word/XLSX would exceed early MVP scope.
