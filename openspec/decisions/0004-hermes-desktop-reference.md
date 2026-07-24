# Decision 0004 — Use Hermes Desktop as Agent Console Reference

## Status

Accepted as reference material only.

## Context

The user surfaced `https://github.com/fathah/hermes-desktop` while PG1 was defining its AI provider strategy, SDD/OpenSpec workflow, and future agentic RAG direction.

Hermes Desktop is an MIT-licensed Electron + React + TypeScript desktop application for installing, configuring, and interacting with Hermes Agent. It includes provider/model management, streaming chat, sessions, profiles, memory, skills, tools, schedules, messaging gateways, and local/remote agent connectivity.

PG1 is not a desktop personal-agent app. It is a web-based academic thesis-review platform with strong evidence, audit, and institutional requirements.

## Decision

Use Hermes Desktop as a **reference for patterns**, not as a PG1 runtime dependency or application base.

PG1 will keep its accepted architecture:

- Angular admin dashboard.
- NestJS + TypeScript API.
- Python FastAPI document/AI worker.
- PostgreSQL + pgvector.
- Redis + BullMQ.
- Local/S3-compatible storage.
- Provider-neutral LLM abstraction for Claude, DeepSeek, and Groq.

## Patterns to Reuse Conceptually

### Provider and model registry

Hermes Desktop has provider/model configuration patterns that are directly relevant to PG1's LLM provider strategy.

PG1 should implement its own backend-owned registry for:

- provider ID: `claude`, `deepseek`, `groq`;
- base URL / API mode;
- model ID;
- enabled/disabled state;
- task routing policy;
- rate limits/timeouts;
- cost metadata when available;
- audit metadata for every AI-assisted output.

### Agent/admin console UX

Hermes Desktop's screens for providers, models, tools, skills, sessions, memory, and settings are useful UI inspiration.

PG1 can adapt the idea into an academic admin panel:

- LLM providers;
- model routing by task;
- normative sources;
- rubric definitions;
- prompt/template versions;
- review-run progress;
- findings and evidence audit;
- cost/usage visibility.

### Streaming progress

Hermes Desktop's streaming/progress model maps well to PG1 review runs.

PG1 should show review progress as stages:

1. upload accepted;
2. extraction queued;
3. parsing/OCR;
4. segmentation;
5. deterministic validation;
6. controlled RAG;
7. evidence audit;
8. report generation;
9. completed/failed/partial.

### Security references

Hermes Desktop includes Electron hardening patterns. These are useful only if PG1 later creates a desktop companion app. They are not immediately relevant to the Angular web MVP.

## Patterns Not to Reuse Directly

- Do not switch PG1 to Electron/React.
- Do not embed Hermes Agent as PG1's backend runtime.
- Do not copy a personal-agent session model as the core academic review model.
- Do not expose provider credentials to the frontend.
- Do not carry over OpenAI defaults; OpenAI remains excluded from PG1's recommended provider set.

## Rationale

Hermes Desktop validates that a provider/model console, profile management, streaming progress, and tool/skill visibility are valuable UX patterns for agentic systems. However, PG1's core product is an auditable academic workflow, so those patterns must be reimplemented around PG1's domain model rather than imported wholesale.

## Consequences

### Positive

- Gives PG1 a concrete UI/UX reference for future AI administration screens.
- Reinforces the Claude/DeepSeek/Groq provider-registry direction.
- Encourages streaming stage visibility for long-running review jobs.
- Avoids reinventing conceptual admin patterns from scratch.

### Tradeoffs

- Requires PG1 to build its own web-native implementation.
- Hermes features can distract from the MVP if copied too broadly.
- Desktop-agent patterns need translation before they fit academic review workflows.

## Follow-up

Add a later implementation slice for `LLM provider registry and routing admin` after the core upload/review/report path is stable, unless provider configuration becomes necessary earlier for controlled RAG.
