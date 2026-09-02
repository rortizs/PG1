# APA 6 Citation Rules Specification

## Purpose

APA 6th-edition citation rules grounded in the institution's own APA manual (confirmed 6th edition throughout; no APA 7 source exists). Adds et-al. author-count thresholds and quote-length formatting to `citations.py`, tagged `source_type: apa_6`. Scoped to text-checkable citation rules only, not reference-list layout (hanging indent, italics) which requires layout-aware extraction.

## Requirements

### Requirement: Et-al. Threshold Enforcement

The system MUST apply APA 6 et-al. thresholds to in-text citations: citations with 1-2 authors MUST always name both authors; citations with 3-5 authors MUST name all authors on first mention and use "et al." from the second mention onward; citations with 6+ authors MUST use "et al." starting from the first mention.

#### Scenario: 1-2 authors always cite both

- GIVEN an in-text citation with 2 authors appears multiple times
- WHEN the citation rule module evaluates each mention
- THEN no et-al. finding is produced for either mention

#### Scenario: 3-5 authors omit et al. on first mention correctly

- GIVEN a citation with 4 authors is fully named on its first mention and abbreviated "et al." on its second
- WHEN the citation rule module evaluates both mentions
- THEN no et-al. finding is produced

#### Scenario: 6+ authors missing et al. on first mention is flagged

- GIVEN a citation with 7 authors is fully named on its first mention
- WHEN the citation rule module evaluates the mention
- THEN a finding is persisted with `normative_source_id` referencing `apa_6`
- AND `evidence_text` quotes the citation as written

### Requirement: Quote-Length Formatting Rule

The system MUST flag direct quotations under 40 words that are not presented inline with quotation marks, and direct quotations of 40 words or more that are not presented as a block quote.

#### Scenario: Short quote formatted inline passes

- GIVEN a 25-word direct quotation appears inline in quotation marks
- WHEN the citation rule module evaluates the quotation
- THEN no quote-length finding is produced

#### Scenario: Long quote not block-formatted is flagged

- GIVEN a 55-word direct quotation appears inline with quotation marks instead of as a block quote
- WHEN the citation rule module evaluates the quotation
- THEN a finding is persisted with `normative_source_id` referencing `apa_6`
- AND `evidence_text` contains the quoted passage
