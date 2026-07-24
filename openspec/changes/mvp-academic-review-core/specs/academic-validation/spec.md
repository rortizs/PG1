# Academic Validation Specification

## Purpose

Define the MVP academic validation behavior for GT, APA 6, writing-style, and congruence checks. This is a new domain spec because no canonical `academic-validation` spec exists yet.

## Requirements

### Requirement: GT Rule-Based Checks

The system MUST evaluate thesis content against configured Guía GT rules where the uploaded document provides sufficient extractable evidence.

#### Scenario: GT issue detected with evidence

- GIVEN a thesis segment violates a configured GT rule
- WHEN the validation step evaluates the segment
- THEN the system MUST produce a finding with GT rule provenance
- AND the finding MUST include page/chapter evidence according to the finding contract
- AND the finding MUST classify the GT issue type

#### Scenario: GT visual format cannot be verified

- GIVEN a GT rule depends on visual layout that cannot be reliably extracted
- WHEN the validation step evaluates the document
- THEN the system MUST mark the check as unverifiable or uncertain
- AND the system MUST NOT fabricate a definitive finding without evidence

### Requirement: APA 6 Rule-Based Checks

The system MUST evaluate citations, references, tables, figures, and applicable formatting markers against configured APA 6 rules where evidence is extractable.

#### Scenario: APA citation issue detected

- GIVEN a thesis contains an in-text citation that violates a configured APA 6 rule
- WHEN APA validation evaluates the relevant segment
- THEN the system MUST produce an APA finding
- AND the finding MUST include evidence text, location provenance, issue type, and APA source provenance

#### Scenario: Reference consistency checked

- GIVEN a thesis includes in-text citations and a reference section
- WHEN APA validation compares citations with references
- THEN the system SHOULD identify missing, inconsistent, or unmatched references when evidence is sufficient
- AND every reported inconsistency MUST include the citation or reference evidence used to make the determination

### Requirement: Writing and Style Checks

The system MUST detect configured writing and style issues, including gerunds, filler words, passive voice, long sentences, spelling, grammar, and academic style problems.

#### Scenario: Writing issue reported

- GIVEN a thesis segment contains a configured writing-style issue
- WHEN writing validation evaluates the segment
- THEN the system MUST produce a writing finding with exact textual evidence
- AND the finding MUST include page/chapter provenance and issue type
- AND the finding SHOULD include a concise academic explanation suitable for reviewer use

### Requirement: Congruence Checks

The system MUST support congruence validation across problem statement, objectives, conclusions, and recommendations when the relevant sections are detectable.

#### Scenario: Objective and conclusion mismatch

- GIVEN the system has detected objectives and conclusions sections
- WHEN congruence validation compares them
- THEN the system SHOULD report material misalignment only when evidence from both sections supports the finding
- AND the finding MUST link evidence snippets from each compared section

#### Scenario: Required sections unavailable

- GIVEN one or more required congruence sections cannot be detected
- WHEN congruence validation runs
- THEN the system MUST mark the congruence check as incomplete
- AND the system MUST NOT assert alignment or misalignment without sufficient evidence

### Requirement: Validation Results Are Auditable

The system MUST distinguish deterministic rule checks, AI-assisted checks, unverifiable checks, and failed checks in persisted validation outputs.

#### Scenario: Reviewer inspects validation provenance

- GIVEN a finding or check result exists
- WHEN the reviewer inspects it
- THEN the system MUST identify whether it came from deterministic rules, AI assistance, controlled RAG, or a later agentic module
- AND the system MUST expose the rule identifier or source provenance when available

## Notes

- Tests MUST be specified before implementing validation modules.
- Implementation SHOULD be split into reviewable rule families to respect the 400-line review budget.
- The proposal did not include a formal `Capabilities` section; this domain was inferred from affected GT, APA, writing, and congruence validation areas.
