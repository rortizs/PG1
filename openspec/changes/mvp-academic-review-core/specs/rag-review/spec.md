# RAG Review Specification

## Purpose

Define controlled RAG over normative sources and constrain the later agentic RAG roadmap so all AI-assisted review remains evidence-grounded. This is a new domain spec because no canonical `rag-review` spec exists yet.

## Requirements

### Requirement: Controlled RAG Over Normative Sources

The system MUST use controlled retrieval over approved normative sources, such as Guía GT and APA 6 references, to support academic validations and explanations.

#### Scenario: Normative source retrieved

- GIVEN approved reference documents have been indexed
- WHEN a validation or explanation requires normative support
- THEN the system MAY retrieve relevant reference segments
- AND any RAG-supported finding MUST identify the reference source or segment used
- AND the finding MUST still include thesis evidence from the uploaded document

#### Scenario: No relevant normative source found

- GIVEN retrieval returns no sufficiently relevant normative source
- WHEN an AI-assisted reviewer proposes a normative finding
- THEN the system MUST NOT cite a nonexistent or unrelated source
- AND the system MUST either omit normative provenance or mark the finding as unsupported by retrieved references

### Requirement: Reference and Thesis Content Separation

The system MUST keep institutional reference retrieval separate from uploaded thesis segmentation.

#### Scenario: RAG indexes reference material

- GIVEN GT or APA reference material is indexed for retrieval
- WHEN embeddings or searchable records are created
- THEN the system MUST identify them as reference records
- AND the system MUST NOT confuse reference segments with thesis evidence snippets

#### Scenario: Finding uses both source classes

- GIVEN a RAG-supported validation compares thesis content against a normative reference
- WHEN the system records the finding
- THEN the finding MUST link thesis evidence separately from normative reference provenance

### Requirement: Structured AI Output Validation

The system MUST validate AI-assisted outputs against the finding/evidence contract before they become reviewer-visible findings.

#### Scenario: AI output satisfies contract

- GIVEN an AI-assisted module proposes a finding with structured fields
- WHEN the system validates the output
- THEN the output MAY become a reviewer-visible finding only if evidence, location, type, confidence, and provenance requirements are satisfied

#### Scenario: AI output hallucinates or omits evidence

- GIVEN an AI-assisted module proposes a finding not grounded in a thesis segment
- WHEN the system validates the output
- THEN the system MUST reject it as a valid finding
- AND the system SHOULD record the rejection for audit or quality improvement

### Requirement: Agentic RAG Is Constrained and Later-Stage

The system MUST treat agentic RAG as a later capability that operates only on structured document segments and approved reference records, not as the initial autonomous review engine.

#### Scenario: Agentic reviewer produces a finding

- GIVEN agentic RAG has been enabled in a future phase
- WHEN an agentic reviewer proposes an APA, GT, writing, methodology, congruence, report, or evidence-audit finding
- THEN the proposed finding MUST satisfy the same evidence, page/chapter, type, confidence, and provenance requirements as non-agentic findings

#### Scenario: Agent cannot verify evidence

- GIVEN an agentic reviewer cannot link its conclusion to thesis evidence
- WHEN it attempts to produce a finding
- THEN the system MUST reject or quarantine the output
- AND the output MUST NOT appear as a final academic observation

### Requirement: AI Review Traceability

The system MUST preserve enough metadata to audit RAG and later agentic RAG review decisions.

#### Scenario: Reviewer audits AI-supported finding

- GIVEN a finding was produced with AI assistance
- WHEN an authorized reviewer inspects its provenance
- THEN the system MUST expose the reviewer module category, retrieved normative source references when used, thesis evidence link, and confidence metadata

## Notes

- Strict TDD applies to retrieval contracts, output schema validation, and hallucination rejection behavior.
- RAG and agentic features SHOULD be implemented in separate reviewable slices under the 400-line budget.
- The proposal did not include a formal `Capabilities` section; this domain was inferred from affected controlled RAG and agentic RAG areas.
