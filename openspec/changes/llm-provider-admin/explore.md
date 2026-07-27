# Exploration — LLM Provider Admin (backoffice for Claude/DeepSeek/Groq credentials + active-provider switch)

## Current State

**Provider selection today (env-var, call-time-lazy):**
- `services/worker/app/providers/llm_provider.py` — `Protocol` `LLMProvider` with one method `generate(prompt, *, max_tokens=1024) -> str`. No provider registry/id concept at this layer.
- `services/worker/app/providers/anthropic_provider.py` — `AnthropicProvider.generate()` (line 37) reads `os.environ.get("ANTHROPIC_API_KEY")` lazily at call time (line 38), not construction time. Raises `AnthropicProviderConfigError` if unset (39-42).
- `services/worker/app/main.py` — `get_llm_provider()` (27-30) is a hardcoded FastAPI `Depends` factory returning `AnthropicProvider()`, injected into `POST /internal/review` (51-65) which calls `run_cag_review(provider, payload.thesis_text)`.
- `services/worker/app/cag_review.py` — `run_cag_review()` (105-140) is fully provider-agnostic, calling `provider.generate(prompt)` once (114). This abstraction already isolates the review logic from credential sourcing.

**Critical architectural fact — call direction is API → Worker, never the reverse.** `services/worker/pyproject.toml` deps (`fastapi, uvicorn, python-multipart, pypdf, python-docx, anthropic, httpx`) contain zero DB clients (no `psycopg`/`asyncpg`/`sqlalchemy`) and the worker makes zero outbound calls. `apps/api/src/jobs/review-orchestrator.mjs`'s `defaultRunCagReview()` (18-32) is the only call site driving CAG review: `fetch(WORKER_BASE_URL + "/internal/review", {body: JSON.stringify({thesis_text})})`. The API already owns Postgres via `apps/api/src/db/review-repository.mjs` (`pg`-based) and `apps/api/src/live-review-pipeline.mjs`'s `getRepository()` (51-58, keyed off `DATABASE_URL`).

**Schema** (`apps/api/src/db/migrations/0001_schema_baseline.sql`, 224 lines, 12 tables) — confirmed **no provider-config table exists**. Conventions: `BIGINT GENERATED ALWAYS AS IDENTITY` PK, snake_case, `TIMESTAMPTZ NOT NULL DEFAULT now()`, `JSONB ... CHECK (jsonb_typeof(metadata)='object')`, `CHECK (... IN (...))` for enums instead of Postgres ENUM types, named multi-column constraints, indexes declared at file bottom, `-- UP`/`-- DOWN` sections.

**Angular** (`apps/web/src/app/app.routes.ts`, 2 routes today: `upload`, `runs/:runId`). Established patterns: standalone + `OnPush` + signals + `inject()` (`upload-page.ts`), one shared typed client `ThesisApiClient` (`providedIn:'root'`), pure framework-free view-model functions tested without TestBed (`results/results-view.ts`, `upload/upload-validation.ts`).

**This feature is already anticipated in an accepted decision.** `openspec/decisions/0004-hermes-desktop-reference.md` — "Provider and model registry" (29-44) specifies exactly this: backend-owned registry with provider ID (`claude`/`deepseek`/`groq`), model ID, enabled state, routing policy, cost metadata, audit metadata; explicitly states "Do not expose provider credentials to the frontend" (line 86); and its Follow-up section (110) literally names *"LLM provider registry and routing admin"* as a deferred slice. `openspec/decisions/0002-llm-provider-strategy.md` confirms Claude/DeepSeek/Groq roles/routing and mandates provider/model metadata for auditability. `openspec/config.yaml` (53-59) confirms the same, OpenAI excluded.

**No existing encryption/secrets utility** — grep of `apps/` for `crypto|encrypt|cipher` found only unrelated sha256/storageKey hashing. `infra/docker-compose.yml` has no app-secret precedent, but the project already tolerates ops-set env vars (`DATABASE_URL`, `WORKER_BASE_URL`, `ANTHROPIC_API_KEY`) so one new static var is consistent.

**Test blast radius** (`services/worker/tests/test_cag_review.py`): `FakeLLMProvider`-based tests (33-93) are provider-agnostic and unaffected. `test_missing_anthropic_api_key_raises_explicit_config_error` (95-111) pops `ANTHROPIC_API_KEY` and asserts failure — its "env var is the sole credential source" premise needs conscious revision once credentials can come from elsewhere. `test_extract.py`/`test_smoke.py` confirmed unaffected (no provider-related matches).

## Affected Areas
- `services/worker/app/providers/anthropic_provider.py` — constructor/`generate()` needs to accept an explicit key/model.
- `services/worker/app/main.py` — `get_llm_provider()` (27-30) + `/internal/review` route (51-65) need provider-selection logic.
- `services/worker/tests/test_cag_review.py:95-111` — needs conscious rework.
- `apps/api/src/jobs/review-orchestrator.mjs:18-32` — the single call site to extend with resolved provider config.
- `apps/api/src/live-review-pipeline.mjs`, `apps/api/src/db/review-repository.mjs`, new migration — new provider-config repository/table.
- `apps/api/src/app.module.ts` — new controller(s) for admin CRUD/activate.
- `apps/web/src/app/` — new `admin/` feature folder, new route(s), new typed client, following existing standalone/signal/pure-view-model conventions.
- `infra/docker-compose.yml` / env wiring — one new static encryption-key var if encryption is chosen.

## Approaches

**Fork 1 — how the worker gets the active provider + credential:**
1. **API embeds resolved config into the existing `/internal/review` request (recommended)** — API resolves active provider from Postgres (already owns it) and adds fields to the JSON body it already sends. Pros: zero new endpoints/call-direction, worker stays DB-free, minimal blast radius. Cons: couples worker's provider construction to the payload shape (acceptable). Effort: Low.
2. **Worker calls new reverse `GET /internal/active-llm-provider` on API.** Pros: resolution logic stays server-side, cacheable. Cons: reverses the only call direction that exists today, adds a second hop for no real gain over option 1. Effort: Medium.
3. **Worker reads Postgres directly.** Pros: self-sufficient. Cons: breaks the deliberate "only API touches Postgres" architecture, duplicates credential-decryption logic in a second runtime, doubles the encryption key's exposure surface. Effort: Medium-High.

**Fork 2 — credential storage:**
1. **App-level symmetric encryption (recommended)** — new `encrypted_api_key` column, key from one new static env var, decrypt only in-memory in the API, mask/last-4 to frontend. Effort: Low-Medium (Node's built-in `crypto` suffices, no new dependency).
2. **Plaintext-in-DB, documented MVP tradeoff** (mirrors the Redis/BullMQ bypass precedent) — directly contradicts the user's implicit "not plaintext without basic protection" expectation; not a real contender.

## Recommendation
Fork 1/Approach 1 + Fork 2/Approach 1: API resolves the active provider from Postgres and passes it in the existing worker request body; store keys AES-encrypted with one new static env-var key. Proposed table (investigation finding, not committed):

```sql
llm_provider_config(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_name TEXT NOT NULL CHECK (provider_name IN ('claude','deepseek','groq')),
  model_id TEXT NOT NULL CHECK (btrim(model_id) <> ''),
  encrypted_api_key TEXT NOT NULL,
  api_key_last_four TEXT,
  is_active BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ... ON llm_provider_config (is_active) WHERE is_active;
```

## Risks

- `test_cag_review.py:95-111` will need conscious rework — flag explicitly for design/tasks so it isn't silently broken or deleted.
- The single encryption-key env var is a single point of failure for all stored credentials — acceptable MVP tradeoff, but must be documented like the Redis/BullMQ bypass precedent from `mvp-vertical-slice`.
- **No auth/authorization exists anywhere in the codebase today** (`uploaded_by_user_id` defaults to `0`, a documented placeholder). A credential-management backoffice currently has no access-control layer to sit behind — the design phase must explicitly accept-for-MVP (e.g. a minimal shared-secret admin header) or address this properly.
- Embedding a decrypted credential in the API→worker request body means it transits an internal HTTP call per review — acceptable given the route is already internal-only, following the same trust assumptions as the existing `WORKER_BASE_URL` usage.

## Ready for Proposal

Yes. This feature was already anticipated in decision 0004 as a deferred follow-up. The investigation found a lower-effort integration path than a literal `.env`-mutation approach: the API should embed resolved provider config into the request it already sends the worker (no new endpoint, no reversed call direction, no worker DB access) — because the worker is architecturally callee-only and DB-free by design today.
