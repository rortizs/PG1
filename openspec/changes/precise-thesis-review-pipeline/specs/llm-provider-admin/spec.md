# Delta for LLM Provider Admin

## MODIFIED Requirements

### Requirement: Provider CRUD via Admin API
The system MUST let an admin create and update an `llm_provider_config` row
with `provider_name` restricted to `claude`, `deepseek`, or `groq`, a
`role` restricted to `judgment` or `triage`, a non-empty `model_id`, and an
API key. The system MUST NOT return the plaintext API key in any response
after save — only a masked/last-4 representation.
(Previously: no `role` field; a single global `is_active` flag governed all providers.)

#### Scenario: Admin creates a valid judgment-role provider config
- GIVEN an authenticated admin request with `provider_name: "claude"`, `role: "judgment"`, a model id, and an API key
- WHEN the create endpoint is called
- THEN the system returns `201` with the new row's masked key (last-4 only) and `role: "judgment"`
- AND the raw key is never present in the response body

#### Scenario: Admin creates a valid triage-role provider config
- GIVEN an authenticated admin request with `provider_name: "deepseek"`, `role: "triage"`, a model id, and an API key
- WHEN the create endpoint is called
- THEN the system returns `201` with `role: "triage"`

#### Scenario: Unsupported role is rejected
- GIVEN a create/update request with `role: "review"`
- WHEN the request is submitted
- THEN the system returns `422 validation_error` naming `role`
- AND no row is created or modified

#### Scenario: Unsupported provider name is rejected
- GIVEN a create/update request with `provider_name: "openai"`
- WHEN the request is submitted
- THEN the system returns `422 validation_error` naming `provider_name`
- AND no row is created or modified

### Requirement: Exactly-One-Active-Provider-Per-Role Invariant
The system MUST enforce that at most one `llm_provider_config` row is active
per `role` at any time. Activating a provider for a role MUST atomically
deactivate any previously active provider for that same role, and MUST NOT
affect the active provider of a different role.
(Previously: a single global exactly-one-active invariant across all roles combined.)

#### Scenario: Activating a new judgment provider deactivates the previous judgment provider only
- GIVEN provider A is active for role `judgment` and provider T is active for role `triage`
- WHEN an admin activates provider B for role `judgment`
- THEN provider B becomes the active `judgment` provider
- AND provider A is deactivated
- AND provider T remains the active `triage` provider, unaffected

#### Scenario: Zero active judgment providers blocks review runs with an explicit error
- GIVEN no `llm_provider_config` row is active for role `judgment`
- WHEN a review run is triggered
- THEN the run fails with an explicit "no active judgment provider configured" error
- AND the system MUST NOT fall back to an environment variable or fabricate a result

#### Scenario: Zero active triage providers does not block review runs
- GIVEN a `judgment` provider is active and no `llm_provider_config` row is active for role `triage`
- WHEN a review run is triggered
- THEN the run proceeds normally, with the judgment provider handling every chunk directly and no triage pass performed

### Requirement: Runtime Active-Provider Credential Resolution
Each review run MUST resolve the currently active provider per role at the
time the run starts (re-resolved per review-run-trigger, never cached for
the life of the process). The `judgment` role's active provider MUST be
resolved and passed to the worker's `/internal/review` call for every run.
The `triage` role's active provider, if one exists, MUST also be resolved
and passed; if none exists, the call proceeds without triage credentials
and MUST NOT error.
(Previously: resolved a single global active provider; now resolved per role, with `judgment` required and `triage` optional.)

#### Scenario: Review run uses the judgment and triage providers active at trigger time
- GIVEN provider A is active for `judgment` and provider T is active for `triage` when a review run is triggered
- WHEN the run's worker call is made
- THEN the worker request carries provider A's name/model/key for `judgment` and provider T's name/model/key for `triage`

#### Scenario: Review run with no triage provider omits triage credentials without error
- GIVEN provider A is active for `judgment` and no provider is active for `triage`
- WHEN the run's worker call is made
- THEN the worker request carries provider A's credentials for `judgment` and no `triage` credentials
- AND the call is not rejected or errored for the missing triage role

#### Scenario: Provider switch takes effect on the next run without restart
- GIVEN a review run using judgment provider A has already completed
- WHEN an admin activates judgment provider B and a new review run is triggered
- THEN the new run's worker call carries provider B's name, model id, and key for `judgment`
- AND no process restart or file edit was required

### Requirement: Backoffice Provider Visibility & Run Provenance
An admin MUST be able to view the provider list (masked keys, role, active
status per role) and, for a completed review run, see which provider (name +
model id) served each role that participated in that run.
(Previously: provenance recorded a single provider per run; now recorded per role, with `triage` provenance present only when a triage provider participated.)

#### Scenario: Admin views the provider list with roles
- GIVEN two provider configs exist — one active for `judgment`, one active for `triage`
- WHEN the admin requests the provider list
- THEN the response includes both rows with masked keys, correct `role`, and correct `is_active` flags

#### Scenario: Admin views which providers handled a completed run
- GIVEN a review run completed using judgment provider A and triage provider T
- WHEN the admin views that run's details
- THEN the response identifies provider A as the `judgment` handler and provider T as the `triage` handler

#### Scenario: Admin views a run that used judgment only
- GIVEN a review run completed using only judgment provider A (no triage provider was configured)
- WHEN the admin views that run's details
- THEN the response identifies provider A as the `judgment` handler and shows no `triage` handler entry
