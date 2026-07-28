# Verify Report: llm-provider-admin

**Change**: llm-provider-admin
**Mode**: hybrid (OpenSpec + Engram)
**Verified**: 2026-07-27
**Verdict**: PASS

## Completeness

All 9 work units in `tasks.md` are marked `[x]` across all RED/GREEN/TRIANGULATE/REFACTOR/Verify/Rollback rows. All 4 planned PRs (A/B/C/D) are committed on `master`:

| Commit | PR | Content |
|---|---|---|
| `30ae84e` | A | migration runner auto-discovery, `0002_llm_provider_config.sql` |
| `3414547` | B | AES-256-GCM cipher, admin CRUD/activate endpoints |
| `f521395` | C | active-provider resolution wired into pipeline, worker explicit key/model, DeepSeek/Groq fail-loud stubs |
| `400a911` | D | Angular `admin/` feature, `0003` provider provenance, runbook |

`git status` is clean; `git log --oneline` shows exactly the expected commits on top of the archived `mvp-vertical-slice` history (`e92fc63` archive commit, then `d7213b9` planning docs, then the 4 PR commits). No unexpected commits, no leftover changes.

## Test Execution Evidence (run independently this session)

### Offline (Docker down; Homebrew postgresql@17 confirmed bound to `127.0.0.1:5432`/`[::1]:5432` via `lsof`)

- `pnpm test` → exit 0
  - `apps/api`: 77 tests declared, 64 pass / 0 fail / 13 skipped (skips are the DB-integration tests correctly self-skipping via `t.skip(...)` when `DATABASE_URL` is unreachable)
  - `apps/web`: 40 pass / 0 fail / 0 skipped
  - `services/worker` (pytest via `unittest discover`): 24 tests, `OK` (0 fail)

### Live (Docker Postgres up, healthy; port remapped 5432→5433 via `infra/docker-compose.yml` to route around the Homebrew Postgres conflict, `DATABASE_URL` pointed at 5433, then the remap fully reverted afterward — confirmed via empty `git diff` and `git status --short` after teardown)

- `pnpm test` (with `DATABASE_URL=postgres://pg1:pg1@localhost:5433/pg1`) → exit 0
  - `apps/api`: 77 pass / 0 fail / 0 skipped (all previously-skipped integration tests now genuinely run and pass, including the live migration test, admin-contract live test, and active-provider-resolution end-to-end test)
  - `apps/web`: 40 pass / 0 fail
  - `services/worker`: 24 tests, `OK`
- Docker torn down (`docker compose down`) after evidence capture; port remap reverted; working tree clean.

These counts match apply-progress.md's claimed final numbers exactly (77/0/live, 64/13/0 offline, 40/0 web, 24/0 worker).

## Spec Compliance Matrix

### Domain: llm-provider-admin (new capability)

| Requirement | Scenario | Implementation | Covering test | Status |
|---|---|---|---|---|
| Provider CRUD via Admin API | Valid create → 201, masked key only | `admin-contract.mjs` `validateCreatePayload` + `provider-config-repository.mjs` `create`/`toMaskedView` | `admin-contract.test.mjs` ("valid claude row" assertions), live variant in same file | PASS |
| Provider CRUD via Admin API | Unsupported `provider_name` → 422, no row created | `validateProviderNameField` against `SUPPORTED_PROVIDER_NAMES` | `admin-contract.test.mjs:87` ("unsupported provider_name is rejected with 422 and never echoes the submitted api_key") | PASS |
| Provider CRUD via Admin API | Update without resubmitting key never re-exposes plaintext | `provider-config-repository.mjs` `update()` — `COALESCE` keeps prior `encrypted_api_key`/`api_key_last_four` when `apiKey === undefined` | `admin-contract.test.mjs` live test, "Update without resubmitting the key preserves the masked key" | PASS |
| Exactly-One-Active Invariant | Activating B deactivates A atomically | `provider-config-repository.mjs` `activate()` — single transaction, deactivate-then-activate | `admin-contract.test.mjs` live test ("Activate deepseek: atomically deactivates claude") + DB-level `0002` partial unique index | PASS |
| Exactly-One-Active Invariant | Zero active → review fails explicitly, no env fallback, no fabrication | `live-review-pipeline.mjs` `runCagReviewWithActiveProvider` throws `"no active LLM provider configured"` | `active-provider-resolution.test.mjs` Scenario 1 (live, end-to-end through the real orchestrator to `review_run.status:"failed"`) | PASS |
| Admin Shared-Secret Gate | Missing header → 401, nothing created/modified | `checkAdminSecretHeader` in `admin-contract.mjs`, enforced both by `AdminSecretGuard` (NestJS layer) and independently inside `handleAdminRequest` | `admin-contract.test.mjs:52` | PASS |
| Admin Shared-Secret Gate | Wrong header value → 403 | Same function, `constantTimeEquals` mismatch branch | `admin-contract.test.mjs:69` | PASS |
| Runtime Active-Provider Credential Resolution | Run uses provider active when triggered; re-resolved per run, not cached | `getProviderRepository()`/`getActiveProvider()` called fresh inside `runCagReviewWithActiveProvider` on every invocation (no process-lifetime caching of the resolved provider itself — only the repository *instance* is cached, not the query result) | `active-provider-resolution.test.mjs` Scenarios 2 and 3 (switch mid-session, no restart, next run picks up the new provider's exact fields) | PASS |
| Credential Storage Integrity | Stored column != plaintext | AES-256-GCM `encryptApiKey` | `provider-key-cipher.test.mjs` round-trip + tamper-detection tests | PASS |
| Credential Storage Integrity | Failure path never leaks raw key in error_summary/logs/audit_event | `runCagReviewWithActiveProvider`/orchestrator catch path never interpolates the key; `admin-contract.mjs` `EncryptionKeyError` handler explicitly never includes the invalid key value | `active-provider-resolution.test.mjs` Scenario 4 (`assert.doesNotMatch(error_summary, /sk-ant-provider-two-secret/)`); `provider-key-cipher.mjs`'s `EncryptionKeyError` doc comment + `admin-contract.test.mjs:114` | PASS |
| Backoffice Provider Visibility & Run Provenance | Admin views list with masked keys + correct `is_active` | `toMaskedView` allowlist in `provider-config-repository.mjs` | `admin-contract.test.mjs` live "List" assertions | PASS |
| Backoffice Provider Visibility & Run Provenance | Admin views which provider handled a completed run | `0003_review_run_provider_provenance.sql` (`llm_provider_name`/`llm_model_id`), `review-repository.mjs` `updateReviewRunStatus`/`getReviewRunProvenance`, `results-view.ts` `formatProviderLabel`/`providerLabel` | `review-repository.test.mjs`, `review-orchestrator.test.mjs`, `review-run-provenance-migration.test.mjs`, `live-review-integration.test.mjs`, `results-view.test.mjs` | PASS |

### Domain: vertical-slice-cag-review (modified delta)

| Requirement | Scenario | Implementation | Covering test | Status |
|---|---|---|---|---|
| Explicit Failure Handling (modified) | No active provider → explicit error, no silent completed, no env fallback | `runCagReviewWithActiveProvider` throw path | `active-provider-resolution.test.mjs` Scenario 1 | PASS |
| Explicit Failure Handling (modified) | Postgres unreachable → 5xx, no ambiguous partial rows (unchanged behavior) | Pre-existing `CONNECTION_ERROR_CODES` handling in `live-review-pipeline.mjs`, untouched by this change | Pre-existing test, still green | PASS |
| Explicit Failure Handling (modified) | Claude API error/timeout with DB-resolved key/model → `failed` + populated `error_summary`, no key leak | Worker `502`/`AnthropicProviderUpstreamError` path unchanged in shape, now fed a DB-resolved key | `active-provider-resolution.test.mjs` Scenario 4; worker's `test_review_endpoint.py` | PASS |

## Security-Critical Checks (read against actual code, not narrative)

1. **Raw/encrypted keys never returned in admin responses**: Confirmed. `provider-config-repository.mjs`'s `toMaskedView()` is an explicit field allowlist (not a spread), used by every read/write path except `getActiveProvider()` (server-internal only, never routed to an HTTP response). `admin-contract.test.mjs`'s live test explicitly asserts `createRes.body.encrypted_api_key === undefined`, `createRes.body.api_key === undefined`, and `JSON.stringify(createRes.body)` does not match the raw submitted key. Grepped the entire `apps/api/src` tree for `encrypted_api_key`/`encryptedApiKey` — every reference is either the cipher module itself, the repository's write/decrypt paths, or doc comments; none reach a response builder. No finding.

2. **Admin guard rejects missing/wrong header with 401/403 using a real constant-time comparison**: Confirmed. `admin-contract.mjs`'s `checkAdminSecretHeader` returns 401 for a missing header, 403 for a wrong one. The comparison itself (`constantTimeEquals`) hashes both sides with SHA-256 first, then uses Node's `crypto.timingSafeEqual` on the fixed-length digests — this correctly avoids both the naive `===` timing leak AND the `timingSafeEqual`-on-raw-strings pitfall (which throws on mismatched lengths, itself a timing/behavioral leak if handled naively) by normalizing to a fixed-size digest first. This is a genuinely secure pattern, not just cosmetic. `AdminSecretGuard` (NestJS layer) delegates to the same function for defense-in-depth. No finding.

3. **`LLM_PROVIDER_ENCRYPTION_KEY` fail-fast validation**: Confirmed, and confirmed it actually fires rather than silently proceeding. `getEncryptionKey()` throws `EncryptionKeyError` for missing, empty, non-hex, too-short, and too-long keys — all five cases have dedicated tests in `provider-key-cipher.test.mjs`, all passing. It is called both at first cipher use AND eagerly at `provider-config-repository.mjs` construction time (before any DB I/O), so a misconfigured key surfaces on the very first admin request or review trigger. No finding.

4. **Exactly-one-active DB constraint genuinely enforced**: Confirmed via an actual test that attempts two active rows and asserts the insert is rejected. `llm-provider-config-migration.test.mjs` inserts one active row, then attempts a second active row and asserts `/duplicate key value violates unique constraint/` is thrown by Postgres itself (not app-level). Ran this test live this session (Docker up, remapped port) — it passed. The `activate()` repository method additionally wraps deactivate+activate in a single transaction so the invariant is never transiently violated. No finding.

## Zero-Active-Provider and DeepSeek/Groq-Not-Implemented Failure Paths

Both genuinely reach a real `review_run.status: "failed"` with a clear, non-crashing `error_summary` — verified by reading the actual tests and by the live test run this session:

- **Zero-active-provider**: `active-provider-resolution.test.mjs` Scenario 1 runs the full real pipeline (real Postgres, real fake-HTTP worker) end to end, asserts `runZeroActive.body.status === "failed"`, `error_summary` matches `/no active LLM provider configured/i`, and — critically — asserts the worker's `/internal/review` was never even called (`worker.getLastReviewBody() === null`), proving the failure happens before any network attempt, not as a downstream crash. This test ran live this session and passed.
- **DeepSeek/Groq**: `test_provider_factory.py`'s `test_deepseek_provider_generate_raises_without_any_network_call`/`test_groq_provider_generate_raises_without_any_network_call` assert `ProviderNotImplementedError` is raised from `.generate()` with the provider name in the message and the raw key explicitly NOT in the message (`assertNotIn("sk-deepseek-key", ...)`). At the FastAPI layer, `main.py`'s `internal_review` catches `ProviderNotImplementedError` and returns a real `501` (not a crash, not a silent 200). This propagates up through the worker call in `defaultRunCagReview`/orchestrator as a genuine `failed` status with a populated `error_summary`, following the exact same catch-and-persist pattern as every other failure mode in this pipeline. Ran the worker's `test_provider_factory.py` this session (part of the 24-test worker suite) — passed both offline and live.

## Regression Check: mvp-vertical-slice protected tests

- `apps/api/tests/contract.test.mjs`: `git diff e92fc63 400a911 -- apps/api/tests/contract.test.mjs` is **empty** — byte-for-byte untouched across all 4 PRs, exactly as design decision #7 required. Passed in both offline and live runs this session (part of the 64/77 apps/api count).
- `apps/web/tests/smoke.test.mjs`: this file WAS intentionally modified in PR D (additive assertions for the new admin feature + a new test block for the admin page). This is correctly scoped and expected — `tasks.md`'s Work Unit 7 rollback note explicitly lists `smoke.test.mjs`'s admin assertions as part of that unit's reversible scope, and design decision #7's "byte-untouched" guarantee was made only for `contract.test.mjs` (the admin-routing isolation seam), never for `smoke.test.mjs`. The diff itself is purely additive (no existing assertion lines changed or removed) and the file passes green. No finding — this is not a regression, it is intentional, correctly-scoped, and behaviorally additive-only.

## Design Coherence

Spot-checked design.md's 11 architecture decisions against the actual code: migration numbering/runner (decisions 1-2) match; partial unique index (3) matches `0002`'s SQL exactly; AES-256-GCM packed format (4) matches `provider-key-cipher.mjs` exactly; fail-fast key validation (5) matches; constant-time admin guard (6) matches and is genuinely constant-time (see security check #2 above); isolated `admin-contract.mjs` (7) matches, confirmed via the untouched-`contract.test.mjs` diff; separate `AdminApiClient` (8) exists as `admin-api-client.ts`; in-memory (not localStorage) secret store (9) matches `admin-secret-store.ts`, and `smoke.test.mjs` itself asserts no `localStorage`/`sessionStorage` usage; DeepSeek/Groq registry-only with loud factory failure (10) matches; worker env fallback kept (11) matches `anthropic_provider.py`'s arg-then-env precedence, itself covered by a dedicated test (`test_explicit_api_key_and_model_take_precedence_over_env_when_both_present`). No deviations found.

## Issues

No CRITICAL issues found.
No WARNING issues found.
No SUGGESTION issues found.

## Final Verdict: PASS

All 9 work units are complete, all spec requirements/scenarios (both the new `llm-provider-admin` capability and the `vertical-slice-cag-review` delta) have corresponding implementation with a passing covering test verified by an independent live+offline run this session, all security-critical checks hold up under direct source inspection (no naive comparisons, no key leaks, no silent fallbacks), the exactly-one-active DB constraint and both zero-active/not-implemented failure paths are genuinely exercised (not merely asserted), the `mvp-vertical-slice` protected-test regression check is clean, and git hygiene is clean. The change is ready for `sdd-archive`.

The one item that remains genuinely unautomatable and unverifiable by an agent — the final real-`ANTHROPIC_API_KEY` manual acceptance step documented in the runbook (Work Unit 9) — is explicitly scoped as a user action in both tasks.md and design.md, not a gap in this change's automated coverage.
