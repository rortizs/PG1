# Decision 0003 — Adopt OpenSpec Workflow for PG1

## Status

Accepted for planning and development workflow.

## Context

PG1 is an AI-assisted university thesis review platform. The project has high correctness and auditability requirements: findings must include evidence, page/chapter provenance, type, confidence/severity, and source metadata. The user identified OpenSpec as the root workflow behind gentle-pi and asked whether it serves this project.

OpenSpec is a lightweight spec framework for AI-assisted development. Its model separates:

- `openspec/specs/`: canonical source of truth for current system behavior.
- `openspec/changes/`: proposed modifications with proposal, specs, design, and tasks.
- archive/sync flows: verified changes can be merged into canonical specs and archived.

## Decision

Use OpenSpec as the durable specification and change-management workflow for PG1.

PG1 will keep product planning and implementation guidance in OpenSpec artifacts, while gentle-pi remains the Pi-specific orchestration harness on top of OpenSpec.

## How PG1 Will Use It

### Canonical specs

Once the first MVP change is verified, its accepted behavior should be synced/archived into canonical specs under:

- `openspec/specs/document-review-core/spec.md`
- `openspec/specs/academic-validation/spec.md`
- `openspec/specs/rag-review/spec.md`
- `openspec/specs/report-generation/spec.md`
- future: `openspec/specs/llm-provider-routing/spec.md`
- future: `openspec/specs/rubric-engine/spec.md`

### Change folders

Every non-trivial feature or architecture shift should create a change folder under `openspec/changes/<change-name>/` with:

- `proposal.md`
- `specs/<domain>/spec.md`
- `design.md`
- `tasks.md`
- optional `verify-report.md`
- optional `apply-progress.md`

### Current active change

The current active change remains:

- `openspec/changes/mvp-academic-review-core/`

This change covers one-to-one upload, document extraction, academic validation, controlled RAG, later constrained agentic RAG, and report generation without OneDrive.

## Why It Serves PG1

OpenSpec fits PG1 because:

- It prevents architecture and requirements from being lost in chat history.
- It supports evidence-first, auditable product decisions.
- It lets the project evolve iteratively without pretending requirements are frozen.
- It naturally separates current accepted behavior from proposed changes.
- It is lightweight enough for early MVP work but structured enough for a thesis-review platform.
- It supports brownfield growth if PG1 later becomes multi-repo or institutional.

## Relationship with gentle-pi

- **OpenSpec** is the durable artifact/spec system.
- **gentle-pi** is the Pi-specific harness that orchestrates SDD phases, subagents, strict TDD, review budget, and skill discovery.
- PG1 should use both: OpenSpec for artifacts, gentle-pi for disciplined execution.

## Risks and Limits

- OpenSpec should not become runtime product infrastructure.
- OpenSpec artifacts are for development governance, not end-user thesis review records.
- PG1 must avoid excessive ceremony for tiny changes.
- Current OpenSpec workspace features are under active development and should not be used as a stable automation foundation yet.
- The project still needs executable tests; specs do not replace verification.

## Practical Rules

- Use OpenSpec for non-trivial changes, architecture decisions, and review-risky work.
- Keep small typo/docs edits outside full SDD ceremony when safe.
- After implementation and verification, sync/archive accepted specs.
- Keep product rules in OpenSpec, but keep runtime audit data in PostgreSQL.
- Use Engram as companion memory, not as a replacement for versioned specs.

## Consequences

### Positive

- Better continuity across sessions.
- Easier review of proposed behavior before code.
- Stronger traceability from decision → spec → design → task → implementation.
- Easier onboarding for future agents or developers.

### Tradeoffs

- Requires discipline to keep artifacts current.
- Adds lightweight planning overhead.
- Needs periodic sync/archive so `openspec/changes/` does not become stale.
