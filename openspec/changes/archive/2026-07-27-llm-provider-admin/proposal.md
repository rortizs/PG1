# Proposal: LLM Provider Admin (DB-backed, admin-switchable provider credentials)

## Intent

Replace the single-provider, `.env`-only `ANTHROPIC_API_KEY` credential source with a
DB-backed, admin-switchable registry. An admin can add/edit provider credentials
(Claude/DeepSeek/Groq) from a backoffice UI, mark exactly one provider "active", and the
system uses that provider for all subsequent CAG review calls with no restart and no file
edit. Fulfills the deferred "LLM provider registry and routing admin" follow-up in decision
`0004` and the provider-neutral mandate in decision `0002`. Runtime `.env` mutation is
rejected (fragile, needs restarts, tooling cannot write `.env*`); one static ops-set
encryption-key env var is the accepted tradeoff.

## Scope

### In Scope
- `llm_provider_config` Postgres table (migration; project schema conventions; partial unique index on `is_active` enforcing exactly one active provider at the DB level).
- NestJS admin endpoints: list / create / update / activate providers.
- AES encryption at rest via Node built-in `crypto` (no new dependency); keys decrypted only in-memory server-side, NEVER returned to frontend (masked / last-4 only after save).
- API resolves the active provider and passes resolved key/model into the existing worker `/internal/review` request body (no new endpoint, no reversed call direction, no worker DB access).
- Worker `AnthropicProvider` accepts explicit key/model instead of env-only. DeepSeek/Groq: registry rows + provider stubs conforming to the `LLMProvider` protocol; real API implementations DEFERRED unless design finds them trivial (decision stated in design).
- Angular `admin/` feature area (standalone + signals + `inject()`, following `upload-page.ts` / `results-view.ts`): provider list, masked-key edit form, activate action, new typed client.
- Minimal shared-secret admin header/token checked server-side (codebase has zero auth today; this proposal MUST NOT ship an unprotected credential UI).

### Out of Scope / Deferred
- Full user authentication/authorization (shared-secret header is a documented temporary MVP gate, NOT real auth).
- Per-request routing / load-balancing across multiple active providers (exactly one active this slice).
- Real DeepSeek/Groq provider API implementations if design finds them non-trivial (Claude stays the only fully-wired call path; registry/UI still support adding those rows).
- Secrets-manager integration (Vault/AWS SM) — one static env-var key is the accepted MVP tradeoff, same precedent as the Redis/BullMQ bypass in `mvp-vertical-slice`.
- Re-litigating the working upload→extract→CAG→persist pipeline — only the credential SOURCE changes.

## Capabilities

### New Capabilities
- `llm-provider-admin`: backoffice management of LLM provider credentials (CRUD + activate), encrypted-at-rest storage, exactly-one-active invariant, shared-secret admin gate, and active-provider resolution feeding the review pipeline.

### Modified Capabilities
- `vertical-slice-cag-review`: CAG review credential source changes from env-only (`ANTHROPIC_API_KEY`) to the DB-resolved active provider passed via the existing worker request; worker provider accepts explicit key/model.

## Approach

API resolves the active provider from Postgres (which it already owns) and embeds the
decrypted key/model into the JSON body it already sends worker `/internal/review`
(explore Fork 1 / Approach 1). Credentials stored AES-encrypted with one static env-var key,
decrypted in-memory only, masked to the frontend (Fork 2 / Approach 1). Worker stays DB-free
and callee-only. New Angular `admin/` feature reuses established standalone/signal/pure-
view-model conventions. TDD (RED→GREEN→TRIANGULATE→REFACTOR) applies in tasks/apply;
`pnpm test` is the runner.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/api/src/db/migrations/` | New | `llm_provider_config` table + partial unique index |
| `apps/api/src/db/` | New | Provider-config repository (encrypt/decrypt, resolve active) |
| `apps/api/src/app.module.ts` + controller | New | Admin CRUD/activate endpoints + shared-secret guard |
| `apps/api/src/jobs/review-orchestrator.mjs:18-32` | Modified | Embed resolved provider config in worker request |
| `apps/api/src/live-review-pipeline.mjs` | Modified | Wire active-provider resolution |
| `services/worker/app/providers/anthropic_provider.py` | Modified | Accept explicit key/model |
| `services/worker/app/main.py:27-30,51-65` | Modified | Provider selection from request payload |
| `services/worker/tests/test_cag_review.py:95-111` | Modified | Env-only-credential assertion needs conscious rework |
| `apps/web/src/app/admin/` + `app.routes.ts` | New | Admin feature area, route, typed client |
| `infra/docker-compose.yml` / env | New | One static encryption-key env var |

## Deviations / Scope-Shortcut Sign-off

- **(a) Encryption-key SPOF**: plaintext credentials never touch frontend or logs, but the single encryption-key env var is a single point of failure for all stored credentials — documented, accepted MVP tradeoff (mirrors Redis/BullMQ bypass precedent).
- **(b) Shared-secret is NOT auth**: the admin header is an explicit, temporary MVP gate, called out as a known gap — NOT presented as real authentication.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `test_cag_review.py:95-111` silently broken/deleted | Med | Flag for deliberate rework in tasks; assert new DB-sourced credential path |
| Encryption-key loss/rotation | Med | Document ops procedure; key is single static var; re-enter creds if rotated |
| Decrypted key transits internal API→worker call | Low | Route already internal-only; same trust as existing `WORKER_BASE_URL` |
| Shared-secret mistaken for real security | Med | Explicit non-goal + doc note; deferred to future auth slice |
| DeepSeek/Groq stubs surface as "working" | Low | UI/registry mark implementation state; only Claude fully wired |

## Non-Goals

- Do NOT reintroduce OpenAI (excluded by project convention `0002`/config).
- Do NOT change CAG "zero-or-one grounded finding, never fabricate" behavior.
- Do NOT break the passing suite without conscious, documented updates (notably `test_cag_review.py:95-111`).

## Rollback Plan

Revert the migration (`-- DOWN` drops `llm_provider_config`), revert API/worker/web commits,
and restore env-only credential sourcing. Because the worker still reads `ANTHROPIC_API_KEY`
as fallback when no provider config is supplied, the pre-change flow remains operable during
rollback.

## Dependencies

- One static encryption-key env var provisioned by ops before activation flows.
- Existing Postgres (`DATABASE_URL`) and internal worker channel (`WORKER_BASE_URL`).

## Success Criteria

- [ ] Admin can create Claude/DeepSeek/Groq rows and mark exactly one active (DB-enforced).
- [ ] Active-provider switch takes effect on the next review run with no restart/file edit.
- [ ] Plaintext keys never returned to frontend or written to logs; only masked/last-4 shown.
- [ ] CAG review uses the DB-resolved active provider's credential (Claude fully wired).
- [ ] Shared-secret admin gate rejects unauthenticated credential-management requests.
- [ ] Reworked `test_cag_review.py` and full `pnpm test` suite pass.

## Proposal Assumptions (orchestrator-provided; open for correction)

Direction was fully specified by the orchestrator, so no interactive question round was run.
Assumptions carried into spec/design: (1) DeepSeek/Groq real API calls are DEFERRED unless
trivial — design decides and states clearly; (2) shared-secret header is the only access
control this slice; (3) encryption is app-level symmetric AES via Node `crypto`. Flag any of
these to trigger a proposal question round before spec/design.
