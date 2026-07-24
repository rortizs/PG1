# Document Review Core Specification

## Purpose

Define the MVP document intake, review lifecycle, segmentation, and evidence contract for manually uploaded thesis reviews. This is a new domain spec because no canonical `document-review-core` spec exists yet.

## Requirements

### Requirement: One-to-One Thesis Upload

The system MUST accept one thesis document per upload request and MUST restrict MVP ingestion to manually uploaded PDF or DOCX files.

#### Scenario: Upload accepted document

- GIVEN an authenticated reviewer has a PDF or DOCX thesis file
- WHEN the reviewer submits the file through the MVP upload flow
- THEN the system MUST create a thesis document record
- AND the system MUST preserve the original file as the source artifact
- AND the system MUST expose the uploaded document for review-run creation

#### Scenario: Reject unsupported upload

- GIVEN an authenticated reviewer has a file that is not PDF or DOCX
- WHEN the reviewer submits the file through the upload flow
- THEN the system MUST reject the upload
- AND the rejection MUST explain that only PDF and DOCX thesis files are supported in the MVP
- AND no review run MUST be started for the rejected file

### Requirement: Cloud Drive Ingestion Exclusion

The system MUST NOT require or perform OneDrive, Google Drive, or cloud-drive synchronization for this change.

#### Scenario: Review without OneDrive

- GIVEN a reviewer wants to review a thesis during the MVP
- WHEN the reviewer starts the process
- THEN the system MUST provide a direct file upload path
- AND the system MUST NOT require OneDrive authentication, folder selection, sync permissions, or cloud-drive file discovery

### Requirement: Review Run Lifecycle

The system MUST represent each review attempt as a review run with an auditable status lifecycle.

Accepted statuses MUST include at least: `queued`, `extracting`, `segmenting`, `validating`, `rag_reviewing`, `reporting`, `completed`, `failed`, and `cancelled`.

#### Scenario: Review run progresses successfully

- GIVEN an uploaded thesis document is eligible for review
- WHEN a reviewer starts a review run
- THEN the system MUST create a review run with status `queued`
- AND the system MUST update status as processing advances
- AND the system MUST end in `completed` only after findings and requested report artifacts are available or explicitly empty

#### Scenario: Review run fails audibly

- GIVEN a review run is processing
- WHEN extraction, segmentation, validation, RAG, or report generation cannot complete
- THEN the system MUST mark the review run as `failed`
- AND the system MUST preserve an error summary suitable for reviewer support
- AND the system MUST NOT present partial findings as final unless they are clearly marked partial

### Requirement: Document Segmentation Traceability

The system MUST segment extracted document content while preserving page, chapter or section, and source provenance for every segment.

#### Scenario: Segment includes provenance

- GIVEN a PDF or DOCX thesis has been accepted for review
- WHEN the system extracts and segments document content
- THEN every persisted segment MUST include source document identity
- AND every segment MUST include page provenance when page information is available
- AND every segment MUST include chapter or section provenance when detected
- AND every segment MUST preserve enough text context to verify later findings

#### Scenario: Page or chapter is uncertain

- GIVEN extraction cannot reliably determine a page, chapter, or section
- WHEN the system persists the affected segment
- THEN the segment MUST be marked with uncertainty metadata
- AND any finding based on that segment MUST expose the uncertainty to the reviewer

### Requirement: Finding and Evidence Contract

The system MUST NOT persist or present an academic finding as valid unless it includes evidence text, page or page uncertainty, chapter/section or location uncertainty, finding type, review run, and rule or source provenance.

#### Scenario: Valid finding created

- GIVEN a validation rule or AI-assisted reviewer identifies an issue
- WHEN the system records the finding
- THEN the finding MUST include a finding type
- AND the finding MUST include evidence text copied or derived from the reviewed thesis segment
- AND the finding MUST include page and chapter/section provenance or explicit uncertainty markers
- AND the finding MUST include confidence or severity metadata
- AND the finding MUST identify the rule, normative source, or reviewer module that produced it

#### Scenario: Finding lacks evidence

- GIVEN a validation module proposes a finding without evidence text or location provenance
- WHEN the system validates the proposed finding
- THEN the system MUST reject it as a valid finding
- OR mark it as non-final diagnostic output that is not shown as an academic observation

### Requirement: Review API Contract

The public MVP API MUST expose versioned review resources for upload, review-run status, findings, evidence, and report artifacts using consistent response and error contracts.

#### Scenario: Reviewer checks run status

- GIVEN a review run exists
- WHEN a client requests the review run status through the versioned API
- THEN the response MUST include the run identifier, current status, timestamps, and progress-relevant summary
- AND error responses MUST use a consistent machine-readable format

#### Scenario: Reviewer lists findings

- GIVEN a review run has produced findings
- WHEN a client requests findings for that run
- THEN the response MUST support pagination or bounded result sets
- AND each finding MUST expose its linked evidence and provenance fields

## Notes

- Implementation MUST be planned with tests before code under strict TDD.
- Future implementation slices SHOULD remain near or below the configured 400-line review budget.
- The proposal did not include a formal `Capabilities` section; this domain was inferred from affected upload, lifecycle, segmentation, API, and evidence areas.
