# Delta for Vertical Slice CAG Review

## ADDED Requirements

### Requirement: Chunked Full-Document Review Execution
The system MUST review the entire extracted document, not an excerpt, by
making exactly one HTTP call from the API to the worker's `/internal/review`
endpoint per review run, with the worker looping internally over
`document_section`s (or ~8-page chunks when section detection is uncertain)
and returning a list of findings covering the full document.

#### Scenario: Full document is reviewed across multiple chunks
- GIVEN a 150-200 page thesis with real per-page and per-section structure extracted
- WHEN a review run is triggered
- THEN the API makes exactly one call to `/internal/review` for the run
- AND the worker's response contains findings drawn from chunks spanning the entire document, not only its first pages

#### Scenario: Every finding carries real page/section provenance
- GIVEN the chunked review produces N findings across a document with both PDF and DOCX source formats represented across runs
- WHEN findings are persisted
- THEN each finding's linked evidence has a real `document_page_id` or `document_section_id` (or an explicit uncertainty flag), for both PDF-sourced and DOCX-sourced runs

### Requirement: Confidence-Threshold-Based Finding Filtering
The system MUST NOT cap the number of findings returned per run or per
chunk. Volume control MUST be achieved exclusively through a conservative
minimum-confidence threshold applied before persistence, biased toward
fewer false positives.

#### Scenario: All grounded findings above threshold are returned
- GIVEN a full-document review identifies 40 genuinely grounded, above-threshold candidate findings
- WHEN the run completes
- THEN all 40 findings are persisted — no top-N truncation is applied
- AND findings are grouped/sorted by severity in the persisted/returned result

#### Scenario: Below-threshold candidate is filtered, not counted toward volume
- GIVEN a candidate finding's confidence score falls below the configured minimum threshold
- WHEN findings are finalized for persistence
- THEN that candidate is discarded and does not appear in the review run's results

### Requirement: Prompt Caching for the Normative Corpus
The system MUST structure LLM requests as system + cacheable normative-corpus
block + per-chunk variable content, reusing the same provider client across
the review run's chunk calls so the normative corpus is cached after the
first call.

#### Scenario: Cache is read on subsequent chunk calls
- GIVEN a review run processes more than one chunk
- WHEN the second and later chunk calls are made to the judgment provider
- THEN the provider's response usage metadata reports a nonzero cache-read token count for those calls

## MODIFIED Requirements

### Requirement: CAG Grounded Finding Generation
Given the fully extracted, page/section-structured thesis document and the
full normative corpus from `data/academic-rules/*.txt`, the system MUST
produce every genuinely evidence-grounded finding across the entire
document via a chunked, multi-call internal review loop, and MUST NOT
persist a finding whose claim cannot be grounded in either the thesis text
or the normative corpus. There is no arbitrary cap on finding count; volume
is controlled solely by confidence-threshold filtering.
(Previously: at most one finding per review run from a single flat-text call.)

#### Scenario: Grounded issues across the document produce multiple findings
- GIVEN the thesis contains multiple passages across different pages/sections that each violate a rule in the normative corpus
- WHEN the chunked CAG review runs
- THEN a `finding` row is created for each genuinely grounded issue, each referencing evidence from its specific source page/section

#### Scenario: No grounded issue yields a valid empty result
- GIVEN no chunk of the thesis contains a passage the judgment provider can ground against the normative corpus
- WHEN the CAG check runs
- THEN zero `finding` rows are created
- AND the review run still completes with status `completed` (not `failed`)

### Requirement: Explicit Failure Handling
The system MUST surface clear, non-silent errors for missing configuration,
unreachable dependencies, or upstream API failures — never a silent no-op.
Credential configuration errors MUST come from the DB-resolved active
provider state for the `judgment` role, not a process-wide `ANTHROPIC_API_KEY`
environment variable. The `judgment` role provider MUST be configured for a
review to run at all; the `triage` role provider is optional.
(Previously: single global active-provider check; now role-scoped, with
`judgment` required and `triage` optional.)

#### Scenario: No active judgment provider configured
- GIVEN no `llm_provider_config` row is active for the `judgment` role
- WHEN the CAG check would run (review-run trigger time)
- THEN the system returns/logs an explicit "no active judgment provider configured" error
- AND no review run is silently marked `completed`
- AND the system MUST NOT fall back to `ANTHROPIC_API_KEY` or fabricate a result

#### Scenario: No triage provider configured does not block the run
- GIVEN a `judgment` provider is active and no `triage` provider is configured
- WHEN a review run is triggered
- THEN the run proceeds using only the judgment provider for every chunk
- AND the run does not fail or log an error for the absent triage role

#### Scenario: Claude API error or timeout
- GIVEN the CAG call to the judgment provider fails or times out using the DB-resolved active provider's key/model
- WHEN the review run is processing
- THEN the `review_run` transitions to `status: "failed"` with a populated `error_summary`
- AND no finding is fabricated to compensate
- AND the `error_summary` does not contain the raw API key

### Requirement: Live Persistence With Evidence Provenance
Every persisted `finding` MUST have at least one linked `finding_evidence`
row pointing to an `evidence_snippet` with real page or section provenance
(or an explicit uncertainty flag) — never a finding with zero evidence rows.
This invariant applies unchanged to every finding in a multi-finding review
run, including deterministic-rule findings produced independently of the
LLM path.
(Previously: stated for a single finding per run; now explicitly restated as
applying independently to each finding among many.)

#### Scenario: Finding without linkable evidence is not persisted
- GIVEN the judgment provider proposes a claim with no locatable text in the thesis
- WHEN the finding would be persisted
- THEN the system rejects/discards the candidate finding instead of writing an unevidenced row
- AND no `finding` row is created for that candidate

#### Scenario: Persisted finding carries page/section evidence
- GIVEN a grounded finding is produced
- WHEN it is persisted
- THEN the linked `evidence_snippet` has a non-empty `evidence_text` and at least one of `page_number`, `document_page_id`, or `document_section_id` set (or an uncertainty flag)

#### Scenario: Every finding among many remains independently grounded
- GIVEN a review run produces 15 findings across the document
- WHEN each finding is persisted
- THEN each of the 15 findings individually satisfies the grounding and evidence-linkage invariant, with no finding exempted because others in the same run are valid
