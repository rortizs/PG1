# Decision 0002 — LLM Provider Strategy

## Status

Accepted for MVP planning.

## Context

The thesis-review platform needs LLMs for academic review assistance, controlled RAG, later constrained agentic RAG, summarization, classification, and possibly embeddings. The user explicitly requested that OpenAI be discarded from the recommended stack and that Groq, DeepSeek, and Claude be evaluated.

The system's top quality attributes remain:

- academic precision;
- evidence traceability;
- exact page/chapter references;
- auditability of AI-assisted outputs;
- no fabricated findings.

## Decision

Use a **provider-neutral LLM abstraction** and exclude OpenAI from the recommended provider set.

Recommended providers:

1. **Claude**
2. **DeepSeek**
3. **Groq**

The implementation must store model/provider metadata for every AI-assisted output, including provider, model, model version when available, prompt/template version, retrieval context IDs, timestamps, and validation result.

## Provider Roles

### Claude

Recommended for:

- academic reasoning;
- thesis-section critique;
- long-context synthesis;
- structured review outputs;
- evidence-aware report drafting;
- later agentic RAG orchestration;
- reviewer-facing explanations.

Rationale:

Claude is strongest fit for nuanced academic judgment, long-form synthesis, and structured critique where correctness, tone, and reasoning quality matter more than raw throughput.

### DeepSeek

Recommended for:

- cost-efficient bulk classification;
- first-pass extraction assistance;
- rubric/checklist pre-evaluation;
- optional reasoning passes;
- large batch review tasks where cost matters.

Rationale:

DeepSeek is attractive for cost-sensitive processing and reasoning-oriented tasks. It should be used behind strict validators because provider support, compliance, and operational guarantees may differ from enterprise-focused providers.

### Groq

Recommended for:

- low-latency open-model inference;
- fast deterministic-style checks;
- interactive UX responses;
- high-throughput classification;
- quick review assistance where speed matters.

Rationale:

Groq is an inference platform optimized for speed. It is useful when the product needs responsive interactions or high-throughput lightweight model calls. It should not be treated as the only source of academic judgment.

## Routing Strategy

Initial routing recommendation:

| Task | Primary | Secondary |
| --- | --- | --- |
| Academic critique | Claude | DeepSeek reasoning |
| Controlled RAG answer synthesis | Claude | DeepSeek |
| Bulk classification | DeepSeek | Groq |
| Low-latency UI assist | Groq | DeepSeek |
| Rubric pre-checks | DeepSeek | Groq |
| Agentic RAG coordinator | Claude | DeepSeek |
| Evidence auditor | Claude | DeepSeek |
| Embeddings | Provider-neutral adapter; final model TBD by benchmark | pgvector-compatible output required |

## Guardrails

- No model may create reviewer-visible findings directly.
- LLM outputs must pass the evidence/finding validator before persistence.
- Any finding citing a normative source must include approved source/segment IDs.
- Any finding about thesis content must include thesis evidence with page/chapter provenance or explicit uncertainty.
- Provider and model metadata are mandatory for auditability.
- Prompts must not attempt to bypass AI detection or disguise generated content.
- If a provider cannot satisfy structured output requirements reliably, its outputs must be quarantined or downgraded to advisory-only.

## Consequences

### Positive

- Avoids vendor lock-in.
- Supports cost/performance routing by task type.
- Keeps Claude available for high-quality academic judgment.
- Uses DeepSeek where cost-efficient batch/reasoning work is valuable.
- Uses Groq where latency and throughput matter.

### Tradeoffs

- More adapter complexity.
- Need provider-specific rate-limit, timeout, retry, and structured-output handling.
- Need benchmarks before finalizing exact models.
- Compliance and data-handling policies must be reviewed before sending real thesis data to each provider.

## Open Questions

- Which Claude model tier should be the default for academic review?
- Which DeepSeek model should be used for reasoning vs bulk classification?
- Which Groq-hosted model should be used for fast classification?
- Which embedding model should be the default for Spanish academic text?
- Are institutional data privacy constraints compatible with all three providers?

## Non-goals

- No OpenAI dependency in the recommended MVP implementation.
- No direct browser calls to LLM providers.
- No use of LLMs to evade AI detectors or academic-integrity controls.
