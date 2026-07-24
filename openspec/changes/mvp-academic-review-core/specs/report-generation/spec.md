# Report Generation Specification

## Purpose

Define MVP report output contracts for academic review results. This is a new domain spec because no canonical `report-generation` spec exists yet.

## Requirements

### Requirement: Evidence-Based Report Artifacts

The system MUST generate report artifacts from completed or explicitly partial review runs using only persisted findings, evidence, and check results.

#### Scenario: Completed review report generated

- GIVEN a review run has completed
- WHEN a reviewer requests a report artifact
- THEN the system MUST generate a report that includes document identity, review run identity, findings summary, and detailed findings
- AND each detailed finding MUST include type, evidence, page/chapter or uncertainty, confidence or severity, and provenance

#### Scenario: Report has no findings

- GIVEN a review run completes without valid findings
- WHEN a report is generated
- THEN the report MUST state that no valid findings were produced
- AND the report MUST NOT invent observations to fill the report

### Requirement: Markdown Report First-Class Output

The system MUST support Markdown as an MVP report output format.

#### Scenario: Reviewer downloads Markdown report

- GIVEN a completed review run exists
- WHEN the reviewer requests the Markdown report
- THEN the system MUST provide a downloadable or viewable Markdown artifact
- AND the artifact MUST preserve finding/evidence traceability in human-readable form

### Requirement: Word and XLSX Report Contracts

The system SHOULD support Word and XLSX report artifacts after the finding/evidence model is stable, and any such artifact MUST preserve the same evidence contract as Markdown.

#### Scenario: Word report generated

- GIVEN Word report generation is enabled
- WHEN a reviewer requests a Word report
- THEN the Word artifact MUST include the same required finding fields as the Markdown report
- AND formatting differences MUST NOT remove evidence, page/chapter, finding type, or provenance information

#### Scenario: Matrix XLSX generated

- GIVEN XLSX matrix generation is enabled
- WHEN a reviewer requests the matrix artifact
- THEN the XLSX artifact MUST represent findings in structured rows
- AND each row MUST include finding type, page/chapter or uncertainty, evidence reference, and provenance

### Requirement: Report Access and Status

The system MUST expose generated report artifacts through review-run-associated access controls and status metadata.

#### Scenario: Report generation pending

- GIVEN report generation has not completed for a review run
- WHEN the reviewer requests the report artifact
- THEN the system MUST return a clear pending or unavailable state
- AND the system MUST NOT return a stale artifact as if it belongs to the current run

#### Scenario: Report belongs to another run

- GIVEN a document has multiple review runs
- WHEN the reviewer accesses a report artifact
- THEN the system MUST identify the review run associated with that artifact
- AND the report MUST NOT mix findings across runs unless explicitly generated as a comparison report by a future change

### Requirement: Partial Report Labeling

The system MUST label partial reports when a review run fails or is cancelled after producing intermediate valid outputs.

#### Scenario: Partial report requested

- GIVEN a review run failed after producing some valid findings
- WHEN a reviewer requests available output
- THEN the system MAY produce a partial report
- AND the report MUST clearly indicate that the review did not complete
- AND the report MUST distinguish valid persisted findings from failed or skipped checks

## Notes

- Tests MUST cover report contracts before implementation.
- Word and XLSX SHOULD be split into separate implementation slices if they would exceed the 400-line review budget.
- The proposal did not include a formal `Capabilities` section; this domain was inferred from affected report output areas.
