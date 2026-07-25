# Verification Report — mvp-vertical-slice

**Change**: mvp-vertical-slice
**Mode**: hybrid (OpenSpec + Engram), full artifact set (proposal/spec/design/tasks/apply-progress)
**Verdict**: PASS WITH WARNINGS (one CRITICAL untested spec scenario found; everything else genuinely implemented and tested)

## Completeness

All 9 work units in `tasks.md` marked `[x]`; `apply-progress.md` confirms all 9 done across PR A/B/C/D. Git log shows exactly 4 clean PR commits (`e64ffad`, `d6073de`, `0d63018`, `ef91eda`) plus 1 baseline (`4838d30`). `git status` clean before and after this verification pass.

## Independent test execution (re-run by verify, not trusted from apply-progress narrative)

| Condition | Command | Result |
|---|---|---|
| Docker down | `pnpm test` | apps/api 44 pass/7 skip/0 fail, apps/web 15 pass/0 fail, worker 13 pass/0 fail. Matches apply-progress claims exactly. |
| Docker up (default port 5432) | `pnpm test` | Same 44/7/0 — confirmed the documented machine-specific quirk: local Homebrew `postgresql@17` binds `127.0.0.1:5432`/`[::1]:5432` ahead of Docker's `0.0.0.0:5432` forward, causing `role "pg1" does not exist` on the default port even with a healthy container. Reproduced exactly as documented — not a hidden regression. |
| Docker up, remapped to 5433 (same workaround apply-progress used; port reverted after — `git diff infra/docker-compose.yml` empty) | `DATABASE_URL=postgres://pg1:pg1@localhost:5433/pg1 pnpm test` | apps/api **51 pass/0 fail**, apps/web 15 pass/0 fail, worker 13 pass/0 fail. Matches apply-progress claims exactly — no regression hidden under the port quirk. |
| Teardown | `docker compose -f infra/docker-compose.yml down -v` | Container, network, volume all cleanly removed. |

## Core evidence-integrity rule — CONFIRMED genuine

- `apps/api/src/db/review-repository.mjs` `persistFinding()`: validates the `evidence` array is non-empty and every snippet has non-blank `evidenceText` **before opening a transaction**; throws `EvidenceRequiredError` pre-write. Inside the transaction, further requires each snippet to carry page/section provenance or an explicit uncertainty flag before insert.
- `apps/api/tests/review-repository.test.mjs` — "rejects a candidate finding with zero evidence rows" test calls `persistFinding` with `evidence: []`, asserts it rejects with `EvidenceRequiredError`, then queries `SELECT count(*) FROM finding WHERE review_run_id = $1` and asserts `0` — genuinely proves zero rows written, not just that the call threw.
- `services/worker/app/cag_review.py` `run_cag_review()`: returns `None` when `payload["finding"]` is `null` (never fabricates); raises `CagReviewError` (never silently coerces to "no finding") on non-JSON response, missing `finding` key, or missing required fields.
- `services/worker/tests/test_cag_review.py` covers grounded / ungrounded / malformed-JSON / missing-fields / missing-API-key / corpus-sanity — 6 cases, all against a `FakeLLMProvider` test double that genuinely invokes the real `run_cag_review` production function.

## Scope boundaries — CONFIRMED preserved, nothing silently over/under-implemented

- `review-run-lifecycle.mjs` and `review-queue.mjs`: created in baseline commit `4838d30`, zero diff across all 4 PR commits (`git diff 4838d30 ef91eda -- <both files>` is empty) — the Redis/BullMQ seam is genuinely untouched.
- No `bullmq`/`redis` dependency anywhere in `apps/api/package.json` or `services/worker/pyproject.toml`.
- No OpenAI references in `apps/api/src` or `services/worker/app`. Only `AnthropicProvider` is wired in `services/worker/app/main.py`'s `get_llm_provider()`.
- `extraction.py`'s only OCR mention is a comment confirming OCR is explicitly NOT done. Schema's `docx`/`xlsx` mentions are unused future-facing `CHECK` constraints (`report.format`, `extracted_page.extraction_method`) — no report-generation code exists anywhere in the codebase.
- No embedding-generation or agentic-RAG code path is wired; `embedding_record` table + `vector` extension exist in the schema but are unused (reserved for later, matching the accepted `mvp-academic-review-core` design, out of this slice's scope).

## Spec compliance matrix (14 scenarios across 6 requirements)

| # | Scenario | Status | Evidence |
|---|---|---|---|
| 1.1 | Valid PDF upload succeeds end to end | PASS | pre-existing `upload-storage.test.mjs` (unmodified, still green) + `live-review-integration.test.mjs` persisted-row proof |
| 1.2 | Unsupported file type rejected (415, `review_run_created: false`) | PASS | `upload-storage.test.mjs` |
| 1.3 | Zero/multiple files rejected (422) | PASS | `upload-storage.test.mjs` |
| 2.1 | Review run completes synchronously | PASS | `inline-review-queue.test.mjs` (await-before-resolve ordering) + `review-orchestrator.test.mjs` + `live-review-integration.test.mjs` |
| 3.1 | Grounded issue → exactly one finding | PASS | `test_cag_review.py` + `review-orchestrator.test.mjs` + `live-review-integration.test.mjs` |
| 3.2 | No grounded issue → valid empty result (still `completed`) | PASS | same three files |
| 4.1 | Finding without linkable evidence not persisted | PASS | `review-repository.test.mjs` zero-evidence-rejection case |
| 4.2 | Persisted finding carries page/section evidence | PASS | `review-repository.test.mjs` write-chain assertions |
| 5.1 | Missing `ANTHROPIC_API_KEY` → explicit config error | PASS | `test_cag_review.py` + manual curl (`500 configuration_error...`) recorded in apply-progress |
| 5.2 | **Postgres unreachable → 5xx** | **CRITICAL — UNTESTED** | Code exists (`isConnectionError`/503 mapping in `api-contract.mjs` lines 55-62, 87-94) but **zero automated test and zero manual runbook step** exercises an actual Postgres-connection-refused scenario. `apply-progress.md` (line 428) documents this only as an *interpretation*, never claims coverage. The review-run-trigger half is arguably covered transitively by the orchestrator's generic never-rethrow catch-all (exercised by the Claude-error test), but the upload-path branch is fully unexercised. |
| 5.3 | Claude API error or timeout → `failed` with `error_summary`, no fabricated finding | PASS | `review-orchestrator.test.mjs` case 3 |
| 6.1 | User views status while processing | PASS | `results-view.test.mjs` (unit, pure view-model) + manual runbook live verification (real `failed` run reflected in real GET reads) |
| 6.2 | User views the persisted finding | WARNING (accepted, documented limitation) | `results-view.test.mjs` unit-tests the `findings` branch of the view model with fixture data; genuinely displaying a **real Claude-produced** grounded finding was never exercised end-to-end because no live `ANTHROPIC_API_KEY` exists in this environment — explicitly and honestly documented as the one remaining human acceptance step in `docs/mvp-vertical-slice-runbook.md` and in `tasks.md`'s own scope guard, not silently claimed done. |
| 6.3 | User views a completed run with no findings | PASS | `results-view.test.mjs` + ungrounded case tested end-to-end via `review-orchestrator`/`live-review-integration` |

**12/14 PASS, 1 CRITICAL (untested scenario), 1 WARNING (documented, honest limitation, not a defect).**

## TDD Compliance (Strict TDD Mode active)

- TDD Cycle Evidence table present in `apply-progress.md`, covering every numbered work unit plus the PR D live-wiring prerequisite with RED/GREEN/TRIANGULATE/REFACTOR columns — spot-checked several rows against actual test files and actual `pnpm test` runs; all cross-references hold.
- Gap: the Postgres-unreachable 503 branch (`api-contract.mjs` lines 55-62, 87-94) has **no corresponding row** in the TDD Cycle Evidence table — it was implemented without a RED→GREEN cycle, consistent with it also having zero test coverage today.
- Assertion quality: scanned new/modified test files (`review-repository.test.mjs`, `review-orchestrator.test.mjs`, `live-review-integration.test.mjs`, `results-view.test.mjs`, `test_cag_review.py`) — zero tautologies, zero ghost-loops-over-possibly-empty-collections (the one `for...of` loop in `review-repository.test.mjs` iterates `seededFiles` after already asserting `length === 4`), no Angular TestBed smoke-tests (this repo deliberately extracts pure view-model functions instead, per its own established `upload-validation.ts` pattern). Assertion quality: clean.

## Git hygiene

`git log --oneline` → exactly `ef91eda`, `0d63018`, `d6073de`, `e64ffad`, `4838d30` (4 PR commits + baseline). `git status` → clean, before and after this verification session (the `infra/docker-compose.yml` temporary port remap used to bypass the local-Postgres port conflict was fully reverted, `git diff` empty).

## Issues

- **CRITICAL**: Spec scenario "Postgres unreachable" (Requirement: Explicit Failure Handling) has implemented code but zero runtime-verified test coverage — neither automated nor the manual runbook exercises a genuine connection-refused case against the upload or review-run-trigger routes. Recommend a small, isolated follow-up: one test that points `DATABASE_URL` at an unreachable host/port and asserts the upload route returns `503`.
- **WARNING**: Scenario 6.2 (viewing a real grounded finding in the UI) is unit-tested only; the full live proof requires a real `ANTHROPIC_API_KEY`, which does not exist in this environment. This is honestly documented everywhere (proposal, `tasks.md` scope guard, runbook) as the one remaining human acceptance step, not a silently-skipped requirement — acceptable as a known, disclosed limitation, not a defect.
- No other CRITICAL/WARNING findings. Everything else was independently verified against real source code and real test execution (not just the apply-progress narrative).

## Recommendation

Not fully clean for archive as-is: one genuine spec-scenario test gap (CRITICAL per verify protocol) exists. Recommend either (a) a tiny follow-up apply pass adding one connection-refused test for the upload path's 503 branch before archiving, or (b) an explicit, conscious risk-acceptance decision by the user to archive with this documented gap, given its narrow blast radius (isolated defensive branch, generic catch-all already covers the review-run-trigger half transitively).
