# Design: LLM Provider Admin

## Technical Approach

The API (which already owns Postgres and is the only caller of the worker) resolves the DB-active provider, decrypts its key in-memory, and injects `provider_name`/`api_key`/`model_id` into the JSON body it already POSTs to worker `/internal/review`. Storage is AES-256-GCM at rest via Node built-in `crypto`. A new NestJS admin controller (behind a shared-secret guard) does CRUD/activate against a new `provider-config-repository.mjs`; admin routing lives in a NEW `admin-contract.mjs` so the contract-tested `api-contract.mjs` stays byte-untouched. Angular gets an `admin/` feature. Only Claude is wired; DeepSeek/Groq are registry rows that fail loudly if used. Realizes decisions `0002`/`0004`.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|----------|--------|----------|-----------|
| 1 | Migration file | `0002_llm_provider_config.sql`, same `-- UP`/`-- DOWN`, identity PK, snake_case, timestamptz, CHECK enums | New numbering scheme | Matches `0001` exactly; only `0001` exists |
| 2 | Migration runner | Extend `migrate.mjs` to glob+sort `migrations/*.sql` and run all in order | Hardcode 2nd path | `DEFAULT_MIGRATION_PATH` is single-file today — 0002 would never run otherwise |
| 3 | One-active invariant | `CREATE UNIQUE INDEX ... ON llm_provider_config (is_active) WHERE is_active` | App-level check | DB-enforced, race-safe; matches proposal |
| 4 | Cipher | AES-256-GCM (authenticated), packed `v1:iv(b64):tag(b64):ct(b64)` | AES-CBC (no integrity) | GCM detects tampering; no new dep |
| 5 | Key env var | `LLM_PROVIDER_ENCRYPTION_KEY` = 64 hex chars (32 bytes); validated fail-fast at first cipher use | Silent weak key | Never proceed insecurely; SPOF accepted (documented) |
| 6 | Admin gate | `AdminSecretGuard` checks `x-admin-secret` == `ADMIN_SHARED_SECRET`; constant-time compare | JWT/session | Explicit temporary MVP gate, NOT auth |
| 7 | Admin routing | New `admin-contract.mjs` + `admin.controller.ts`; delegate like existing controllers | Add routes to `api-contract.mjs` | Protects `contract.test.mjs` seam assertions |
| 8 | Admin web client | New sibling `AdminApiClient` | Extend `ThesisApiClient` | Different concern + secret header; keeps thesis client clean |
| 9 | Admin secret UX | Session prompt held in a memory signal, sent per admin request; NOT localStorage, NOT build-time | Bundle-baked secret / localStorage | Build-time leaks secret into shipped JS; localStorage persists/leaks. In-memory dies on refresh (acceptable MVP) |
| 10 | DeepSeek/Groq | Registry/UI rows ONLY; worker factory raises `LLMProviderError` if activated+used | Real API impls now | Real impls need per-provider structured-output validation (0002 guardrails), rate limits, untestable without keys — not trivial |
| 11 | Env fallback (worker) | KEEP `ANTHROPIC_API_KEY` fallback when payload omits key | Remove fully | Rollback plan + local dev + existing tests depend on it |

## Data Flow

    Angular /admin/llm-providers ─(x-admin-secret)─▶ NestJS admin.controller ─▶ admin-contract ─▶ provider-config-repository
                                                                                         │ encrypt/decrypt (GCM)
                                                                                         ▼ Postgres llm_provider_config
    review run ▶ live-review-pipeline.resolveActiveProvider() ─decrypt─▶ runCagReview({thesisText, provider_name, api_key, model_id})
                        │ (zero active → throw → orchestrator catch → review_run.status='failed', error_summary)
                        ▼ POST /internal/review {thesis_text, provider_name, api_key, model_id} ─▶ worker factory ─▶ AnthropicProvider(key,model)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `apps/api/src/db/migrations/0002_llm_provider_config.sql` | Create | Table + partial unique index |
| `apps/api/src/db/migrate.mjs` | Modify | Discover+run all migrations in sorted order |
| `apps/api/src/security/provider-key-cipher.mjs` | Create | `encryptApiKey`/`decryptApiKey`/`getEncryptionKey` |
| `apps/api/src/db/provider-config-repository.mjs` | Create | CRUD + `getActiveProvider()`, encrypt on write |
| `apps/api/src/admin-contract.mjs` | Create | Admin request handler (masks keys) |
| `apps/api/src/admin/admin.controller.ts` + `admin-secret.guard.ts` | Create | Routes + guard; register in `app.module.ts` |
| `apps/api/src/live-review-pipeline.mjs` | Modify | Resolve+decrypt active provider, pass to pipeline |
| `apps/api/src/jobs/review-orchestrator.mjs` | Modify | `defaultRunCagReview` forwards provider fields |
| `services/worker/app/main.py` | Modify | `ReviewRequest` +optional provider fields; factory selects provider |
| `services/worker/app/providers/anthropic_provider.py` | Modify | `__init__(api_key=None, model=...)`; `generate` uses arg then env |
| `apps/web/src/app/admin/*` + `app.routes.ts` | Create/Modify | Page, pure `admin-providers-view.ts`, `AdminApiClient`, route |
| `infra/docker-compose.yml` / `.env.example` (manual) | Modify | `LLM_PROVIDER_ENCRYPTION_KEY`, `ADMIN_SHARED_SECRET` |

## Interfaces / Contracts

`llm_provider_config(id, provider_name CHECK IN ('claude','deepseek','groq'), model_id CHECK btrim<>'', encrypted_api_key, api_key_last_four, is_active BOOL DEFAULT false, metadata JSONB, created_at, updated_at)` + partial unique index on `is_active`.

Cipher: `encryptApiKey(plaintext)->packed`, `decryptApiKey(packed)->plaintext`, `getEncryptionKey()` throws if missing/≠32 bytes.

Admin routes (all require `x-admin-secret`): `GET /api/v1/admin/llm-providers` (list, masked), `POST` (create), `PATCH /:id` (update; key write-only), `POST /:id/activate`. Responses NEVER include `encrypted_api_key`/plaintext — only `api_key_last_four`.

Worker body adds: `provider_name?`, `api_key?`, `model_id?`. Missing → Anthropic + env fallback.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | Cipher GCM round-trip + tamper-reject + bad-key fail-fast; view-model masking; guard reject | node:test / no live services |
| Unit | Worker factory selection; deepseek/groq raise; `AnthropicProvider(api_key=...)` precedence over env | pytest, no key |
| Integration | Migration up/down on live pg; repo one-active invariant; zero-active → `failed` + `error_summary` | Docker pg, mocked worker |

**STRICT TDD flags:** (a) `test_cag_review.py:95-111` conscious rework — RED first: assert env-fallback still errors when BOTH payload key and env absent, add test that payload `api_key` is used over env. (b) Cipher/guard/one-active/zero-active are RED-first. (c) `contract.test.mjs` MUST stay green (admin isolated in `admin-contract.mjs`) — no edits. (d) DeepSeek/Groq "not implemented" is a required RED test, not a silent stub.

## Threat Matrix

| Boundary | Applicability | Note |
|----------|---------------|------|
| Routing / shell / subprocess / VCS-PR / exec-file class | N/A | None introduced |
| Process integration (API→worker carrying secret) | Applicable | Route internal-only (localhost); timeout preserved; key never logged. Carry as apply guard |
| Secret exposure surface | Applicable | Plaintext never to frontend/logs; masked/last-4 only; guard on all admin routes. RED tests on masking + guard |

## Migration / Rollout

`0002` runs after `0001` via ordered runner (PR-A style). Rollback: `-- DOWN` drops table; worker env fallback keeps pre-change flow operable.

## Open Questions

- [ ] Default model ids for future DeepSeek/Groq rows (non-blocking; Claude default `claude-sonnet-4-20250514`).
