# Delta for vertical-slice-cag-review

## MODIFIED Requirements

### Requirement: Explicit Failure Handling
The system MUST surface clear, non-silent errors for missing configuration,
unreachable dependencies, or upstream API failures — never a silent no-op.
Credential configuration errors MUST come from the DB-resolved active
provider state, not a process-wide `ANTHROPIC_API_KEY` environment variable.
(Previously: the sole configuration-error trigger was a missing
`ANTHROPIC_API_KEY` env var; now it is the absence of an active
`llm_provider_config` row, resolved per review-run-trigger.)

#### Scenario: No active LLM provider configured
- GIVEN no `llm_provider_config` row is marked active
- WHEN the CAG check would run (review-run trigger time)
- THEN the system returns/logs an explicit "no active LLM provider configured" error
- AND no review run is silently marked `completed`
- AND the system MUST NOT fall back to `ANTHROPIC_API_KEY` or fabricate a result

#### Scenario: Postgres unreachable
- GIVEN Postgres is not reachable
- WHEN an upload or review-run request is made
- THEN the API returns a `5xx` error with a clear message
- AND no partial rows are left in an ambiguous state

#### Scenario: Claude API error or timeout
- GIVEN the CAG call to Claude fails or times out using the DB-resolved active provider's key/model
- WHEN the review run is processing
- THEN the `review_run` transitions to `status: "failed"` with a populated `error_summary`
- AND no finding is fabricated to compensate
- AND the `error_summary` does not contain the raw API key
