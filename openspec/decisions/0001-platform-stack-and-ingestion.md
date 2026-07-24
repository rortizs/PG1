# Decision 0001 — Platform Stack and Ingestion Strategy

## Status

Accepted for MVP planning.

## Context

The project is an AI-assisted university thesis review platform. The primary quality driver is academic precision: every finding must include exact evidence, page, chapter/section, and error type. The system should evolve from a controlled review pipeline into controlled RAG and later agentic RAG, without OneDrive integration in the initial scope.

The project history explicitly rejects generic findings without evidence and requires formal, auditable academic observations.

## Decision

Use a hybrid architecture:

- **Frontend MVP**: Angular admin dashboard.
- **Future mobile/hybrid UI**: Ionic only if needed after MVP validation.
- **Backend API**: NestJS + TypeScript.
- **Document/AI worker**: Python + FastAPI.
- **Database**: PostgreSQL + pgvector.
- **Queue**: Redis + BullMQ initially.
- **Workflow orchestration later**: Temporal only if processing workflows outgrow BullMQ.
- **Object storage**: Local filesystem in development, S3-compatible storage for deployable environments.
- **AI provider**: provider-neutral LLM abstraction with OpenAI excluded from the recommended provider set.
- **Recommended LLM providers**: Claude, DeepSeek, and Groq.
- **Ingestion MVP**: one-to-one manual upload of PDF/DOCX files.
- **Out of scope for now**: OneDrive integration.
- **AI roadmap**: deterministic extraction/rules first, controlled RAG second, agentic RAG third.

## Rationale

### Why Angular admin first

The MVP is an administrative/document-review system, not a mobile-first product. Angular provides strong conventions for forms, routing, guards, services, dashboards, and enterprise-style workflows. Ionic can be added later if mobile or hybrid access becomes a product requirement.

### Why NestJS for the API

NestJS gives a structured TypeScript backend that pairs naturally with Angular and supports modular APIs, authentication, jobs, report endpoints, audit trails, and future multi-user flows better than an unstructured Express backend.

### Why Python FastAPI for document and AI work

Document parsing, OCR, NLP, embeddings, RAG, and agentic pipelines fit Python's ecosystem better than Node-only processing. FastAPI keeps the worker service explicit, testable, and independently scalable.

### Why PostgreSQL + pgvector

The domain requires traceability and relational integrity:

- thesis document → review run
- review run → findings
- finding → evidence snippet
- evidence snippet → page/chapter/section
- report → generated artifacts
- embedding record → source segment

PostgreSQL supports this auditability while pgvector provides a pragmatic path for controlled RAG without introducing a separate vector database too early.

### Why Redis + BullMQ first

The initial workflows need background jobs, status tracking, retries, and queue separation. BullMQ is sufficient for the MVP. Temporal is reserved for later if review workflows become long-running, branching, or compensation-heavy.

### Why no OneDrive initially

OneDrive solves institutional ingestion, not academic precision. Adding it early introduces OAuth, permissions, file-version ambiguity, duplicate documents, and accidental processing risks before the review engine is reliable. Manual one-to-one upload gives better control while validating the core academic review pipeline.

### Why exclude OpenAI from the recommended provider set

The system should not be coupled to OpenAI as the default LLM provider. The product needs provider choice, auditability, cost control, and the ability to route different academic review tasks to the most appropriate model family. OpenAI can remain technically replaceable through an adapter interface if ever required, but it is not part of the recommended stack for this project.

### Why Claude, DeepSeek, and Groq

- **Claude** is recommended for high-precision academic reasoning, structured review, long-context synthesis, evidence-sensitive critique, and later agentic review orchestration.
- **DeepSeek** is recommended for cost-efficient bulk operations such as classification, extraction assistance, first-pass rubric checks, and optional reasoning passes where privacy/compliance constraints allow it.
- **Groq** is recommended as an inference platform for very low-latency open-model tasks: quick classification, deterministic-style checks, interactive UX, and high-throughput review assistance.

The architecture must record model/provider metadata on AI-assisted outputs so findings remain auditable.

## Consequences

### Positive

- Strong separation between product API and AI/document processing.
- Better auditability for academic findings.
- Clear path from rules to controlled RAG to agentic RAG.
- Avoids premature integration complexity.
- Keeps the MVP focused on precision and evidence.

### Negative / Tradeoffs

- Two backend runtimes must be maintained: Node/NestJS and Python/FastAPI.
- Cross-service contracts must be carefully specified and tested.
- Manual upload is less automated than institutional OneDrive ingestion.
- pgvector is pragmatic for MVP but may need replacement or augmentation if retrieval scale grows significantly.

## Non-goals

- No OneDrive connection in the current roadmap segment.
- No mobile-first Ionic implementation for the MVP.
- No fully autonomous agentic review before structured parsing, evidence tracking, and controlled RAG are reliable.
- No OpenAI dependency in the recommended MVP stack.
- No findings without evidence, page/chapter location, and type classification.

## Review Budget

Changes should target a maximum of **400 changed lines per review unit**. Larger changes should be split or auto-forecasted into smaller reviewable work units.

## Strict TDD Note

Strict TDD is active in OpenSpec config. The current test command is a placeholder until scaffolding exists. Once code is generated, component-specific test commands must replace the placeholder.
