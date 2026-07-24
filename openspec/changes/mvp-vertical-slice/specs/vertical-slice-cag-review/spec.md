# Vertical Slice CAG Review Specification

## Purpose

Define the synchronous, end-to-end MVP flow: a user uploads a thesis file through
a real Angular UI, the file is stored via the real NestJS API, one Claude-backed
CAG check runs against the static normative corpus, the resulting finding (or
explicit no-finding outcome) is persisted to a live Postgres+pgvector database,
and the result is visible in the UI. This is a temporary synchronous shortcut;
Redis/BullMQ remain the target architecture (`review-run-lifecycle.mjs` /
`review-queue.mjs` stay as the swap-in seam, not deleted or bypassed in code).

## Requirements

### Requirement: UI-Driven Thesis Upload
The system MUST let a user select and submit exactly one PDF or DOCX file from
the Angular app, and the API MUST persist the accepted upload as a real row in
`thesis_document` (not in-memory), reusing the existing validation contract.

#### Scenario: Valid PDF upload succeeds end to end
- GIVEN the Angular upload page is open and Postgres is reachable
- WHEN the user selects one valid PDF and submits
- THEN the API returns `201` with `upload_status: "uploaded"`
- AND a row exists in `thesis_document` with matching `sha256`, `content_type`, `storage_key`

#### Scenario: Unsupported file type is rejected
- GIVEN the upload page is open
- WHEN the user submits a file whose content type is not PDF or DOCX
- THEN the API returns `415 unsupported_media_type` with `review_run_created: false`
- AND no `thesis_document` row is created

#### Scenario: Zero or multiple files are rejected
- GIVEN the upload page is open
- WHEN the user submits zero files or more than one file in a single request
- THEN the API returns `422 validation_error` naming the `files` field
- AND no `thesis_document` row is created

### Requirement: Synchronous Review-Run Trigger
Starting a review run for an uploaded document MUST process synchronously
within the triggering request/response cycle for this slice, and MUST result
in the `review_run` row reaching a terminal status (`completed` or `failed`).

#### Scenario: Review run completes synchronously
- GIVEN a thesis document exists with `upload_status: "uploaded"`
- WHEN the user triggers a review run
- THEN the request does not return until the run reaches `completed` or `failed`
- AND the `review_run` row's `status`, `started_at`, and `completed_at`/`failed_at` reflect the outcome

### Requirement: CAG Grounded Finding Generation
Given the thesis text (or a representative extracted excerpt) and the full
normative corpus from `data/academic-rules/*.txt`, the system MUST produce at
most one finding per review run, and MUST NOT persist a finding whose claim
cannot be grounded in either the thesis text or the normative corpus.

#### Scenario: Grounded issue produces exactly one finding
- GIVEN the thesis excerpt contains a passage that violates a rule in the normative corpus
- WHEN the CAG check runs
- THEN exactly one `finding` row is created, referencing evidence from the thesis text

#### Scenario: No grounded issue yields a valid empty result
- GIVEN the thesis excerpt has no passage Claude can ground against the normative corpus
- WHEN the CAG check runs
- THEN zero `finding` rows are created
- AND the review run still completes with status `completed` (not `failed`)

### Requirement: Live Persistence With Evidence Provenance
Every persisted `finding` MUST have at least one linked `finding_evidence` row
pointing to an `evidence_snippet` with real page or section provenance (or an
explicit uncertainty flag) — never a finding with zero evidence rows.

#### Scenario: Finding without linkable evidence is not persisted
- GIVEN Claude proposes a claim with no locatable text in the thesis
- WHEN the finding would be persisted
- THEN the system rejects/discards the candidate finding instead of writing an unevidenced row
- AND no `finding` row is created for that candidate

#### Scenario: Persisted finding carries page/section evidence
- GIVEN a grounded finding is produced
- WHEN it is persisted
- THEN the linked `evidence_snippet` has a non-empty `evidence_text` and at least one of `page_number`, `document_page_id`, or `document_section_id` set (or an uncertainty flag)

### Requirement: Explicit Failure Handling
The system MUST surface clear, non-silent errors for missing configuration,
unreachable dependencies, or upstream API failures — never a silent no-op.

#### Scenario: Missing ANTHROPIC_API_KEY
- GIVEN `ANTHROPIC_API_KEY` is not set
- WHEN the CAG check would run (startup or request time)
- THEN the system returns/logs an explicit configuration error identifying the missing key
- AND no review run is silently marked `completed`

#### Scenario: Postgres unreachable
- GIVEN Postgres is not reachable
- WHEN an upload or review-run request is made
- THEN the API returns a `5xx` error with a clear message
- AND no partial rows are left in an ambiguous state

#### Scenario: Claude API error or timeout
- GIVEN the CAG call to Claude fails or times out
- WHEN the review run is processing
- THEN the `review_run` transitions to `status: "failed"` with a populated `error_summary`
- AND no finding is fabricated to compensate

### Requirement: UI Visibility of Real Results
The Angular app MUST display review-run status and, once complete, the
persisted finding(s) with evidence text, by reading live data from the API.

#### Scenario: User views status while processing
- GIVEN a review run is in progress
- WHEN the user views the results page
- THEN the UI shows the run's current status from a real API call

#### Scenario: User views the persisted finding
- GIVEN a review run has completed with one finding
- WHEN the user views the results page
- THEN the UI shows the finding's title, explanation, and evidence text sourced from the API response

#### Scenario: User views a completed run with no findings
- GIVEN a review run completed with zero findings
- WHEN the user views the results page
- THEN the UI shows a "no findings" state, not an error
