# LLM Provider Admin Specification

## Purpose

Backoffice management of LLM provider credentials (Claude/DeepSeek/Groq):
CRUD + activate, encrypted-at-rest storage, exactly-one-active invariant,
a temporary shared-secret admin gate, and active-provider resolution that
feeds the CAG review pipeline. Fulfills the deferred registry follow-up in
decision `0004`.

## Requirements

### Requirement: Provider CRUD via Admin API
The system MUST let an admin create and update an `llm_provider_config` row
with `provider_name` restricted to `claude`, `deepseek`, or `groq`, a
non-empty `model_id`, and an API key. The system MUST NOT return the
plaintext API key in any response after save — only a masked/last-4
representation.

#### Scenario: Admin creates a valid provider config
- GIVEN an authenticated admin request with `provider_name: "claude"`, a model id, and an API key
- WHEN the create endpoint is called
- THEN the system returns `201` with the new row's masked key (last-4 only)
- AND the raw key is never present in the response body

#### Scenario: Unsupported provider name is rejected
- GIVEN a create/update request with `provider_name: "openai"`
- WHEN the request is submitted
- THEN the system returns `422 validation_error` naming `provider_name`
- AND no row is created or modified

#### Scenario: Update never re-exposes the stored key
- GIVEN an existing provider config
- WHEN an admin updates its `model_id` without resubmitting the key
- THEN the response contains the same masked/last-4 representation, never the plaintext key

### Requirement: Exactly-One-Active Provider Invariant
The system MUST enforce that at most one `llm_provider_config` row is active
at any time. Activating a provider MUST atomically deactivate any
previously active provider.

#### Scenario: Activating a new provider deactivates the previous one
- GIVEN provider A is active and provider B is inactive
- WHEN an admin activates provider B
- THEN provider B becomes active
- AND provider A is deactivated in the same operation

#### Scenario: Zero active providers blocks review runs with an explicit error
- GIVEN no `llm_provider_config` row is active
- WHEN a review run is triggered
- THEN the run fails with an explicit "no active LLM provider configured" error
- AND the system MUST NOT fall back to an environment variable or fabricate a result

### Requirement: Admin Shared-Secret Access Gate (Temporary MVP)
Admin CRUD/activate endpoints MUST require a shared-secret header. This is a
documented temporary MVP gate, NOT full authentication/authorization.

#### Scenario: Request without the shared-secret header is rejected
- GIVEN a request to an admin endpoint with no shared-secret header
- WHEN the request is submitted
- THEN the system returns `401 unauthorized`
- AND no provider data is created, modified, or returned

#### Scenario: Request with an incorrect shared-secret value is rejected
- GIVEN a request with a shared-secret header value that does not match the configured secret
- WHEN the request is submitted
- THEN the system returns `403 forbidden`

### Requirement: Runtime Active-Provider Credential Resolution
Each review run MUST resolve the currently active provider at the time the
run starts (re-resolved per review-run-trigger, never cached for the life of
the process), and MUST pass the resolved provider name, model id, and
decrypted key to the worker's `/internal/review` call instead of relying on
a process-wide `ANTHROPIC_API_KEY` environment variable.

#### Scenario: Review run uses the provider active at trigger time
- GIVEN provider A is active when a review run is triggered
- WHEN the run's worker call is made
- THEN the worker request carries provider A's name, model id, and key

#### Scenario: Provider switch takes effect on the next run without restart
- GIVEN a review run using provider A has already completed
- WHEN an admin activates provider B and a new review run is triggered
- THEN the new run's worker call carries provider B's name, model id, and key
- AND no process restart or file edit was required

### Requirement: Credential Storage Integrity
API keys MUST be stored AES-encrypted at rest. A review run's failure/error
path MUST NOT include the raw key value in error messages, logs,
`finding` rows, or `audit_event` rows.

#### Scenario: Stored key is encrypted, not plaintext
- GIVEN an admin saves a provider config with an API key
- WHEN the row is read directly from storage
- THEN the key column value is not equal to the plaintext key submitted

#### Scenario: Provider failure does not leak the key
- GIVEN the active provider's upstream call fails
- WHEN the review run transitions to `failed` and an `error_summary` is recorded
- THEN neither the `error_summary`, any log output, nor any `audit_event.message` contains the raw API key

### Requirement: Backoffice Provider Visibility & Run Provenance
An admin MUST be able to view the provider list (masked keys, active status)
and, for a completed review run, see which provider (name + model id)
handled it. No existing `review_run`/`finding`/`audit_event` field carries
this today; a new field for provider provenance MUST be added and populated.

#### Scenario: Admin views the provider list
- GIVEN two provider configs exist, one active
- WHEN the admin requests the provider list
- THEN the response includes both rows with masked keys and correct `is_active` flags

#### Scenario: Admin views which provider handled a completed run
- GIVEN a review run completed using provider A
- WHEN the admin views that run's details
- THEN the response identifies provider A's name and model id as the handler
