# Tasks: LLM Provider Admin (DB-backed, admin-switchable provider credentials)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 1,300–1,900 across migration/runner fix, cipher module, admin backend (repo+contract+controller+guard), pipeline wiring, worker provider changes, Angular admin feature, provenance columns, docs |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR A (migration infra) → PR B (crypto + admin backend) → PR C (pipeline wiring + worker + registry stubs) → PR D (Angular admin UI + provenance + manual verification) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `migrate.mjs` glob+sort auto-discovery of migration files | PR A | `pnpm --dir apps/api test` | `node apps/api/src/db/migrate.mjs up` against dockerized pg | revert `migrate.mjs` to hardcoded single-file path |
| 2 | `0002_llm_provider_config.sql` (table + partial unique index) | PR A | `pnpm --dir apps/api test` | `migrate.mjs up`/`down` against dockerized pg | `migrate.mjs down` for `0002`, or delete the file |
| 3 | AES-256-GCM `provider-key-cipher.mjs` + fail-fast key validation | PR B | `pnpm --dir apps/api test` | N/A (pure unit, no live services) | delete `provider-key-cipher.mjs` |
| 4 | Admin CRUD/activate endpoints behind shared-secret guard | PR B | `pnpm --dir apps/api test` | `pnpm --dir apps/api start` + curl against dockerized pg | delete `admin-contract.mjs`/`admin.controller.ts`/`admin-secret.guard.ts`/`provider-config-repository.mjs`; revert `app.module.ts` |
| 5 | Active-provider resolution wired into review pipeline + worker explicit key/model | PR C | `pnpm --dir apps/api test && pnpm --dir services/worker test` | end-to-end run: dockerized pg + local worker with one active Claude row | revert `live-review-pipeline.mjs`/`review-orchestrator.mjs`/`main.py`/`anthropic_provider.py`; env fallback keeps pre-change flow operable |
| 6 | DeepSeek/Groq registry rows, fail-loud "not yet implemented" | PR C | `pnpm --dir services/worker test` | N/A (fail-loud path only, no live keys) | revert factory branch |
| 7 | Angular `admin/` feature (list, form, activate, session-scoped secret prompt) | PR D | `pnpm --dir apps/web test` | `pnpm --dir apps/web start` against running admin API | revert `apps/web/src/app/admin/` + `app.routes.ts` |
| 8 | Provider provenance on `review_run` + results view | PR D | `pnpm --dir apps/api test && pnpm --dir apps/web test` | dockerized-pg run rendering provider in results view | drop `0003`'s added columns; revert `review-repository.mjs`/`results-view.ts` |
| 9 | Manual end-to-end verification with real Claude key entered via UI | PR D | N/A — not part of `pnpm test` | user-run script with real `ANTHROPIC_API_KEY` entered through `/admin/llm-providers` | N/A, verification only |

## Scope Guard

- Only Claude is fully wired; DeepSeek/Groq are registry rows only and fail loudly ("not yet implemented") when activated+used — never silently stubbed as success.
- Worker keeps the `ANTHROPIC_API_KEY` env fallback (design decision #11) — pre-change flow stays operable during rollback and for local dev without the admin UI.
- `x-admin-secret` shared-secret gate is an explicit temporary MVP measure, NOT real authentication — never presented as such in UI copy or docs.
- Admin routing lives in the isolated new `admin-contract.mjs`; `apps/api/tests/contract.test.mjs` MUST stay byte-untouched and green throughout (design decision #7).
- Plaintext API keys NEVER cross to the frontend, logs, `error_summary`, or `audit_event.message` — only masked/last-4 representations after save.
- Admin secret held client-side in an in-memory signal only (design decision #9) — never localStorage, never build-time baked.
- No OpenAI reintroduction (project convention `0002`).
- Work Unit 8's `review_run` provenance columns are an inferred addition — design.md's File Changes table scopes `0002` to the registry table only, with no explicit column names for run provenance. Confirmed as a follow-on `0003` migration during apply; flag before merging if a different location was intended.

## Work Units

### 1. Migration runner auto-discovery

- [x] RED: Extend `apps/api/tests/migrate-runner.test.mjs` asserting `migrate.mjs` discovers all `*.sql` files under `apps/api/src/db/migrations/` via glob+sort (not the hardcoded `DEFAULT_MIGRATION_PATH` single path) — add a second fixture migration and assert both apply in filename order.
- [x] GREEN: Modify `apps/api/src/db/migrate.mjs` to replace the hardcoded `0001_schema_baseline.sql` path with `fs.readdir`+sort-based discovery.
- [x] TRIANGULATE: Confirm `0001` alone still applies with no regression; confirm out-of-order filenames still sort correctly.
- [x] REFACTOR: Extract discovery into a `listMigrationFiles()` helper for reuse/testability.
- [x] Verify: `pnpm --dir apps/api test` green; manual `migrate.mjs up`/`down` cycle against dockerized pg with 2 fixture files.
- [x] Rollback: revert `migrate.mjs` to hardcoded single-file path (`0001` keeps working, still first alphabetically).

### 2. `0002_llm_provider_config.sql` migration

- [x] RED: Add up/down assertions that `llm_provider_config` gets CHECK constraints on `provider_name`/`model_id` and the partial unique index enforcing exactly-one-active; inserting two active rows in the same test must violate the index.
- [x] GREEN: Create `apps/api/src/db/migrations/0002_llm_provider_config.sql` (`-- UP`/`-- DOWN`), table per design's Interfaces/Contracts, `CREATE UNIQUE INDEX ... ON llm_provider_config (is_active) WHERE is_active`.
- [x] TRIANGULATE: Confirm `0002` runs after `0001` via Work Unit 1's ordered runner; confirm `-- DOWN` cleanly drops the table.
- [x] REFACTOR: N/A — single migration file, no shared logic yet.
- [x] Verify: `pnpm --dir apps/api test` green; manual `migrate.mjs up` confirms `llm_provider_config` exists among all tables.
- [x] Rollback: `migrate.mjs down` for `0002`, or delete the file (table never created).

### 3. AES-256-GCM encryption module

- [x] RED: Add `apps/api/tests/provider-key-cipher.test.mjs` (node:test) asserting encrypt→decrypt round-trip; tampering with the packed ciphertext throws (GCM auth failure); `getEncryptionKey()` throws when `LLM_PROVIDER_ENCRYPTION_KEY` is missing or not exactly 64 hex chars.
- [x] GREEN: Create `apps/api/src/security/provider-key-cipher.mjs` — `encryptApiKey`/`decryptApiKey` (packed `v1:iv(b64):tag(b64):ct(b64)`), `getEncryptionKey()` fail-fast validation.
- [x] TRIANGULATE: Cover empty-string key, non-hex key, and wrong-byte-length key as separate fail-fast cases.
- [x] REFACTOR: N/A — module stays self-contained.
- [x] Verify: `pnpm --dir apps/api test` green; no live services required.
- [x] Rollback: delete `provider-key-cipher.mjs`; nothing else depends on it yet.

### 4. Admin CRUD + activate endpoints

- [x] RED: Add `apps/api/tests/admin-contract.test.mjs`: create without `x-admin-secret` → 401; wrong secret → 403; `provider_name: "openai"` → 422; valid claude row → 201 + masked/last-4 key only; update without resubmitting key preserves masked key; activate atomically deactivates the previously active row.
- [x] GREEN: Create `apps/api/src/db/provider-config-repository.mjs` (CRUD + `getActiveProvider()`, encrypts on write), `apps/api/src/admin-contract.mjs` (masks keys in every response), `apps/api/src/admin/admin.controller.ts` + `admin-secret.guard.ts` (constant-time compare); register in `app.module.ts`.
- [x] TRIANGULATE: Confirm `contract.test.mjs` stays byte-untouched and green; confirm list endpoint never includes `encrypted_api_key`.
- [x] REFACTOR: Share response-masking logic between create/update/list handlers.
- [x] Verify: `pnpm --dir apps/api test` green (incl. untouched `contract.test.mjs`); manual `pnpm --dir apps/api start` + curl against all 4 admin routes.
- [x] Rollback: delete `admin-contract.mjs`/`admin.controller.ts`/`admin-secret.guard.ts`/`provider-config-repository.mjs`; revert `app.module.ts`.

### 5. Active-provider resolution wired into review pipeline

- [ ] RED: (a) Assert `live-review-pipeline.mjs` throws "no active LLM provider configured" with zero active rows, surfacing as `review_run.status: "failed"` + `error_summary` (no raw key). (b) Consciously rework `services/worker/tests/test_cag_review.py:95-111` — keep the both-absent failure case, ADD a case asserting payload `api_key`/`model_id` take precedence over env when both present.
- [ ] GREEN: Modify `apps/api/src/live-review-pipeline.mjs` to resolve+decrypt the active provider per review-run-trigger; modify `apps/api/src/jobs/review-orchestrator.mjs`'s `defaultRunCagReview` to forward `provider_name`/`api_key`/`model_id`; modify `services/worker/app/main.py` (optional `ReviewRequest` fields, factory selection) and `anthropic_provider.py` (`__init__(api_key=None, model=...)`, arg-then-env precedence per design decision #11).
- [ ] TRIANGULATE: Two sequential runs with different active providers each carry the correct provider's fields (no restart needed).
- [ ] REFACTOR: Ensure the raw key never appears in `error_summary`, logs, or `audit_event.message` on a failure path.
- [ ] Verify: `pnpm --dir apps/api test && pnpm --dir services/worker test` green; manual end-to-end run with one active Claude row.
- [ ] Rollback: revert `live-review-pipeline.mjs`/`review-orchestrator.mjs`/`main.py`/`anthropic_provider.py`; kept env fallback means `ANTHROPIC_API_KEY`-only flow still operates.

### 6. DeepSeek/Groq registry stubs

- [ ] RED: Add a worker test asserting the provider factory raises a clear `LLMProviderError` (not a silent stub) when `provider_name` is `deepseek` or `groq`.
- [ ] GREEN: Add a worker-side factory branch raising `LLMProviderError("not yet implemented")` for deepseek/groq — no real API call attempted.
- [ ] TRIANGULATE: Confirm an admin can still create/activate a deepseek/groq row via Work Unit 4's admin API; failure only occurs at review-run time, not create/activate time.
- [ ] REFACTOR: N/A — single factory branch addition.
- [ ] Verify: `pnpm --dir services/worker test` green; no live DeepSeek/Groq keys required.
- [ ] Rollback: revert factory branch.

### 7. Angular `admin/` feature

- [ ] RED: Add `apps/web/tests/admin-providers-view.test.mjs` for the not-yet-existing pure `admin-providers-view.ts`: empty list, masked-key rendering, add-form submit payload (key write-only), activate payload, session-scoped secret prompt gating requests.
- [ ] GREEN: Scaffold `apps/web/src/app/admin/` (standalone + signals + `inject()`): provider list page, add/edit form, activate action, new `AdminApiClient` sending `x-admin-secret`; add `/admin/llm-providers` route in `app.routes.ts`; secret held in an in-memory signal, prompted once per session (design decision #9).
- [ ] TRIANGULATE: Cover 401/403 UI states surfacing a clear error, not a silent failure.
- [ ] REFACTOR: Extract shared masked-key display formatting if duplicated between list/edit views.
- [ ] Verify: `pnpm --dir apps/web test` green; manual `pnpm --dir apps/web start` — add+activate a claude row, confirm plaintext key never appears in DOM/network after save.
- [ ] Rollback: revert `apps/web/src/app/admin/` + `app.routes.ts` route entry.

### 8. Provider provenance on results view

- [ ] RED: Add a repository test asserting a completed `review_run` records the provider name + model id that handled it; add a results-view test asserting the view model surfaces "which provider handled this run".
- [ ] GREEN: Add `apps/api/src/db/migrations/0003_review_run_provider_provenance.sql` (`llm_provider_name`, `llm_model_id` columns); populate in `review-repository.mjs` on run completion; surface in `apps/web/src/app/results/results-view.ts`.
- [ ] TRIANGULATE: Runs completed before this change (NULL columns) render a graceful "unknown provider" state, not an error.
- [ ] REFACTOR: N/A — additive columns only.
- [ ] Verify: `pnpm --dir apps/api test && pnpm --dir apps/web test` green; manual run shows the results view naming the provider.
- [ ] Rollback: drop `0003`'s columns via its `-- DOWN`; revert `review-repository.mjs`/`results-view.ts` provenance surfacing.

### 9. Manual end-to-end verification

- [ ] RED: N/A — cannot be automated without a live `ANTHROPIC_API_KEY` entered through the UI.
- [ ] GREEN: N/A — extend `docs/mvp-vertical-slice-runbook.md` with an "LLM Provider Admin" section: set `LLM_PROVIDER_ENCRYPTION_KEY`/`ADMIN_SHARED_SECRET`, run `migrate.mjs up` (`0002`/`0003`), open `/admin/llm-providers`, enter the session secret, add+activate a real Claude row, trigger a review run, confirm the results view names Claude as the handler.
- [ ] TRIANGULATE: N/A — documentation only.
- [ ] REFACTOR: N/A.
- [ ] Verify: manual step — user follows the runbook with a real `ANTHROPIC_API_KEY` entered via the UI (never `.env`) and confirms an end-to-end run using the DB-resolved provider.
- [ ] Rollback: N/A — docs only.

## Suggested PR Chain

1. **PR A — Migration infra**: Work Units 1–2.
2. **PR B — Crypto + admin backend**: Work Units 3–4.
3. **PR C — Pipeline wiring + worker + registry stubs**: Work Units 5–6.
4. **PR D — Angular admin UI + provenance + manual verification**: Work Units 7–9.
