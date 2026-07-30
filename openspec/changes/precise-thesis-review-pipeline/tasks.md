# Tasks: Precise Multi-Finding Thesis Review Pipeline

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~2,700-3,000 total across 7 PRs (see per-PR estimates below) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 section detection+persistence → PR2 deterministic rules → PR3 DOCX→PDF → PR4 provider protocol (breaking) → PR5 chunked review loop+contract → PR6 role-based provider assignment → PR7 real DeepSeek triage |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Design's Migration/Rollout section names 6 revertable slices. Slice 4 ("chunked LLM loop +
cache-aware protocol") is split here into PR4/PR5 for review-load reasons only — the
breaking provider-protocol change (D5) is separable from the chunk-loop rewrite (D4), and
the proposal's own Rollback Plan already treats "the provider-protocol slice" as reverting
to "the flat `generate(prompt)` signature and single-call review", confirming PR4 alone can
stand with cag_review.py still doing one call. PR5 remains the single highest-risk PR
(~650-750 lines: full `cag_review.py` rewrite + `main.py` contract + orchestrator wiring +
3 `.mjs` test reworks) — flag for a possible apply-time `size:exception` if it grows further.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Heading-heuristic section detection in `extraction.py` | PR1 | `pnpm --dir services/worker test` (pytest via `test_extract.py`) | N/A — pure text-in/struct-out unit | revert `extraction.py`'s detection additions |
| 2 | `insertDocumentPages`/`insertDocumentSections` in `review-repository.mjs` | PR1 | `pnpm --dir apps/api test` | dockerized pg | delete the two functions; drop no schema (no migration) |
| 3 | `/internal/extract` gains `sections`; orchestrator wires real FK ids into `persistFinding` | PR1 | `pnpm --dir apps/api test && pnpm --dir services/worker test` | end-to-end run against dockerized pg + local worker | revert `main.py`/`review-orchestrator.mjs` FK-wiring diff |
| 4 | Deterministic rule engine (`services/worker/app/rules/`) | PR2 | `pnpm --dir services/worker test` | N/A — pure text unit tests | delete `app/rules/` package |
| 5 | `/internal/rules` endpoint + independent Node persistence | PR2 | `pnpm --dir apps/api test && pnpm --dir services/worker test` | end-to-end run, LLM path forced-failed to prove isolation | revert `main.py`'s new route + orchestrator's rules call/persist |
| 6 | DOCX→PDF conversion (`_convert_docx_to_pdf`, `DocxConversionError`) | PR3 | `pnpm --dir services/worker test` | manual DOCX upload against local `soffice` | revert `extraction.py`'s DOCX path; DOCX uploads fail extraction again (no new schema to unwind) |
| 7 | Cache-aware provider protocol (`PromptBlock`/`CompletionResult`/`complete()`) | PR4 | `pnpm --dir services/worker test` | N/A — provider unit tests with fakes | revert protocol files; `cag_review.py` call site reverts with them |
| 8 | Chunked multi-finding review loop + `/internal/review` contract | PR5 | `pnpm --dir services/worker test && pnpm --dir apps/api test` | end-to-end run: 150+pp fixture thesis, dockerized pg + local worker | revert `cag_review.py`, `main.py` contract, orchestrator loop, 4 rewritten test suites together |
| 9 | Role-based provider assignment (migrations 0004/0005, repo, admin, UI) | PR6 | `pnpm --dir apps/api test && pnpm --dir apps/web test` | `migrate.mjs up`/`down` against dockerized pg + `pnpm --dir apps/web start` | `migrate.mjs down` for 0005 then 0004; revert repo/admin/UI diffs |
| 10 | Real `DeepSeekProvider` wired as `triage` | PR7 | `pnpm --dir services/worker test` | manual triage-role run with a real `DEEPSEEK_API_KEY` | revert `deepseek_provider.py`; factory falls back to `UnimplementedProvider` |

## Scope Guard

- No arbitrary finding cap, ever — volume control is `MIN_LLM_CONFIDENCE = 0.75` only (Question Round #1/#5). Do not reintroduce a per-chunk/per-run top-N.
- `GROUNDING_FUZZ_MIN = 95` (`rapidfuzz.partial_ratio`), `DEDUP_MIN = 92` (`rapidfuzz.token_set_ratio`) are conservative defaults from design — do not loosen without a design amendment.
- Dedup drops the lower-confidence duplicate; it never merges into multi-evidence.
- `/internal/rules` MUST import nothing from `app/providers/` (D9) — structurally incapable of an LLM call; this is itself a RED-testable import-boundary assertion.
- LibreOffice missing/crash/timeout MUST fail loud (`DocxConversionError` → HTTP 422 → `review_run.status='failed'`) — never silently degrade to section-only.
- `admin-contract.mjs` PATCH MUST reject a `role` field (immutable) — only create sets it.
- `judgment` role is required for any review to run; `triage` absent must never error (fail-open at the loop level, not just at resolution).
- Cross-review-run prompt-cache reuse needs `ANTHROPIC_CACHE_TTL=1h`; the safe default is `5m` (omits the beta header) — re-verify the exact header/premium against live Anthropic docs before hardcoding either value (Open Question).
- Untouched, must stay green byte-for-byte throughout: `contract.test.mjs`, `smoke.test.mjs`, `upload-storage.test.mjs`, `postgres-unreachable.test.mjs`, `test_smoke.py`, `test_provider_factory.py`'s non-DeepSeek assertions, and `review-repository.test.mjs`'s existing single-`persistFinding` case.
- No OpenAI reintroduction (carried convention from `llm-provider-admin`).

## Work Units

### 1. Heading-heuristic section detection

- [ ] RED: Extend `services/worker/tests/test_extract.py` with the D2 pattern table (chapter/GT-keyword/numbered/ALL-CAPS regex rows incl. accent-folded `CAPÌTULO`/`TEORICO`/`BIBLIOGRAFIA`), TOC dotted-leader exclusion, and confidence/`is_location_uncertain` assignment — asserts current extraction has no section-boundary detection at all (spec: PDF Per-Page Section Detection, Explicit Uncertainty Flagging).
- [ ] GREEN: Implement heading detection in `services/worker/app/extraction.py`, emitting `ExtractedSection` with `title`/`normalized_title`/`start_page_number`/`end_page_number`/`parent_section_id` via level-stack/`start_offset`/`end_offset`/`is_location_uncertain`.
- [ ] TRIANGULATE: Zero-headings document → zero sections, no crash. Ambiguous ALL-CAPS line inside a references block is excluded, not misdetected.
- [ ] REFACTOR: Extract the pattern table into a single ordered list shared by detection and tests.
- [ ] Verify: `pnpm --dir services/worker test` green.
- [ ] Rollback: revert `extraction.py`'s detection additions; `/internal/extract` keeps returning pages only.

### 2. `insertDocumentPages`/`insertDocumentSections`

- [ ] RED: Add `apps/api/tests/review-repository.test.mjs` cases: N pages in → N `document_page` rows with real `page_number`; M sections in document order → M `document_section` rows with `parentIndex` resolved to real FK ids (spec: Structural Persistence to document_page and document_section).
- [ ] GREEN: Implement both functions per D3 (single BEGIN/COMMIT, ordered `INSERT ... RETURNING id`, `idByPageNumber`/`idByIndex` maps).
- [ ] TRIANGULATE: Parent-before-child ordering violation raises, not silently orphans a section.
- [ ] REFACTOR: Share the BEGIN/COMMIT batching helper if one already exists in the file.
- [ ] Verify: `pnpm --dir apps/api test` green against dockerized pg.
- [ ] Rollback: delete both functions; no migration to unwind.

### 3. `/internal/extract` sections + real FK wiring into `persistFinding`

- [ ] RED: Extend `test_extract.py`'s endpoint-shape test and `apps/api/tests/review-orchestrator.test.mjs` to assert `/internal/extract`'s response carries `sections[]` and that the orchestrator calls `insertDocumentPages`/`insertDocumentSections` before persisting any finding (currently `documentPageId`/`documentSectionId` are always `null`).
- [ ] GREEN: `main.py`'s extract route returns `sections`; `review-orchestrator.mjs` inserts pages/sections first, then wires `persistFinding.documentPageId`/`documentSectionId` from the returned id maps.
- [ ] TRIANGULATE: A run with zero detected sections still persists pages and findings with `documentSectionId: null` but never crashes.
- [ ] REFACTOR: N/A — wiring only.
- [ ] Verify: `pnpm --dir apps/api test && pnpm --dir services/worker test` green; manual run confirms non-null FK ids in `document_page`/`document_section`.
- [ ] Rollback: revert `main.py`/`review-orchestrator.mjs` FK-wiring diff; findings return to `null` FKs (today's behavior).

### 4. Deterministic rule engine

- [ ] RED: New `services/worker/tests/test_rules.py` — one case per module: filler-word lexicon match; long-sentence via `pysbd` (incl. "Dr. García" abbreviation NOT splitting, per spec); spelling flag gated by the lowercase/len>=4/no-acronym/no-digit/not-in-citation conservatism rule; citation-vs-reference cross-check both directions; GT structure missing-section check against the corpus-verified expected set; below-`MIN_RULE_CONFIDENCE=0.70` candidates discarded (spec: all 6 Deterministic Writing Rules requirements).
- [ ] GREEN: Implement `services/worker/app/rules/{__init__,base,segmentation,filler_words,long_sentences,spelling,citations,gt_structure}.py` per D8; `run_rules(pages, sections) -> list[RuleFinding]` imports no provider module.
- [ ] TRIANGULATE: Zero sections detected → GT structure check skipped entirely (no evidence, no finding), never fabricated.
- [ ] REFACTOR: Extract shared normalization (accent/case fold) into `base.py`, reused by segmentation and citation matching.
- [ ] Verify: `pnpm --dir services/worker test` green; assert `rules/__init__.py` has zero import of `app.providers.*` (import-boundary test from Scope Guard).
- [ ] Rollback: delete `services/worker/app/rules/` package; `pyproject.toml` dep additions become unused but harmless.

### 5. `/internal/rules` endpoint + independent Node persistence

- [ ] RED: `test_review_endpoint.py` case for `POST /internal/rules` (`{pages, sections}` in, `{findings}` out, zero LLM calls observed via a provider-call spy). `review-orchestrator.test.mjs` case: LLM path forced to throw → rule findings still persist with `producer_type='deterministic_rule'`, and the inverse (spec: Independence from the LLM Review Path).
- [ ] GREEN: Add `/internal/rules` route in `main.py`; `review-orchestrator.mjs` calls `/internal/rules` and `/internal/review` in **separate** `try/catch` blocks, each persisting its own result set; `updateReviewRunStatus` gains `metadata` (COALESCE pattern) for `partial_failure` recording.
- [ ] TRIANGULATE: Both paths failing → `status='failed'` (today's behavior, unchanged); exactly one failing → `status='completed'` with `metadata.partial_failure`.
- [ ] REFACTOR: N/A — isolation is structural per D9, not a shared abstraction.
- [ ] Verify: `pnpm --dir apps/api test && pnpm --dir services/worker test` green; manual run with a deliberately broken judgment provider still yields persisted rule findings.
- [ ] Rollback: revert `main.py`'s new route and the orchestrator's independent rules call/persist; deterministic findings stop being produced, LLM path unaffected.

### 6. DOCX→PDF conversion

- [ ] RED: `test_extract.py` cases per the Threat Matrix's "Subprocess argument composition" row: hostile filename (`"; rm -rf /"`) never reaches argv (only fixed `input.docx` does); `SOFFICE_BINARY=/nonexistent` → `DocxConversionError`; a stub binary that always times out → `DocxConversionError`, no hang; non-zero exit → `DocxConversionError`; temp dir removed on both success and failure paths. Plus spec scenarios: DOCX produces real page numbers; DOCX and PDF share extraction behavior.
- [ ] GREEN: Implement `_convert_docx_to_pdf`/`DocxConversionError` per D1 exactly (`shell=False` list argv, per-call `-env:UserInstallation` profile, `timeout=120s`, fixed `input.docx` inside a fresh `TemporaryDirectory`); `_extract_docx()` delegates to the unchanged `_extract_pdf()`.
- [ ] TRIANGULATE: Renamed-executable upload (ZIP bomb / script disguised as `.docx`) → `CorruptFileError`/`DocxConversionError`, never executed.
- [ ] REFACTOR: N/A — single self-contained function.
- [ ] Verify: `pnpm --dir services/worker test` green; manual DOCX upload against a real local `soffice` produces real per-page text.
- [ ] Rollback: revert `extraction.py`'s DOCX path; DOCX uploads fail extraction with today's error (no schema to unwind).

### 7. Cache-aware provider protocol (breaking)

- [ ] RED: `services/worker/tests/test_provider_factory.py`/provider unit tests assert `AnthropicProvider.complete(system_blocks, user_text, max_tokens)` exists and `.generate()` does not; `system_blocks` with `cacheable=True` map to `cache_control`; `response.usage.cache_read_input_tokens`/`cache_creation_input_tokens` populate `CompletionResult`. `UnimplementedProvider.complete()` raises `ProviderNotImplementedError` (Groq only, DeepSeek stub removed here).
- [ ] GREEN: Add `PromptBlock`/`CompletionResult`/`LLMProvider.complete()` to `llm_provider.py`; rewrite `anthropic_provider.py`'s system-block mapping and usage extraction; `unimplemented_provider.py`'s `generate` → `complete`. Adapt `cag_review.py`'s single existing call site to `complete()` — loop shape stays single-call for this PR.
- [ ] TRIANGULATE: `CACHE_TTL` env unset → `5m` default, no beta header; `ANTHROPIC_CACHE_TTL=1h` → beta header present.
- [ ] REFACTOR: N/A — protocol definitions are the deliverable.
- [ ] Verify: `pnpm --dir services/worker test` green.
- [ ] Rollback: revert protocol files and the `cag_review.py` call-site diff together; restores flat `generate(prompt)` and single-call review (per proposal's Rollback Plan).

### 8. Chunked multi-finding review loop + `/internal/review` contract

- [ ] RED (worker): Rework `services/worker/tests/test_cag_review.py` per the design's Deliberate Test Rework table — `FakeLLMProvider` implements `complete()`; assert **N chunk calls** (one per section / 8-page fallback window), a **list** return (not `CagFinding | None`), corpus block present with `cacheable=True`, `MIN_LLM_CONFIDENCE=0.75` drop, `GROUNDING_FUZZ_MIN=95` drop, `DEDUP_MIN=92` drop-not-merge, results sorted `(severity desc, page asc)`, no cap (spec: Chunked Full-Document Review Execution, Confidence-Threshold-Based Finding Filtering, Prompt Caching for the Normative Corpus, CAG Grounded Finding Generation).
- [ ] RED (api): Rework `apps/api/tests/active-provider-resolution.test.mjs` (new body shape: `{pages, sections, judgment_provider, triage_provider}`, exact-body `deepEqual`), `apps/api/tests/live-review-integration.test.mjs` (`findings.length >= 2` instead of `=== 1`, real non-null page/section ids), `apps/api/tests/review-orchestrator.test.mjs` (~L231-264: replace `deepEqual(getLastBody(), {thesis_text: "Old-style call."})` — legacy shape intentionally removed on both with- and without-provider paths).
- [ ] GREEN: Rewrite `cag_review.py`'s chunk planner (one chunk per `document_section`, split at `MAX_CHUNK_PAGES=8`/`MAX_CHUNK_CHARS=24_000`, `CONTEXT_TAIL_CHARS=800`, zero-sections fallback to fixed windows with `section_index=null`), `grounded()` (NFC+casefold, exact-substring then `partial_ratio>=95`), dedup (`token_set_ratio>=92`, chunk distance <=1, drop lower-confidence), `dropped_*`/`cache_*` stats. Update `main.py`'s `/internal/review` to the new request/response contract and `DEFAULT_WORKER_REVIEW_TIMEOUT_MS=900_000`. Update `review-orchestrator.mjs` to persist every finding in the returned list via `idByPageNumber`/`idByIndex`.
- [ ] TRIANGULATE: A malformed/non-JSON provider response still raises `CagReviewError` (never a silent "clean" result); zero grounded issues across the whole document → 0 findings, run still `completed`.
- [ ] REFACTOR: Extract chunk-planning and grounding/dedup into named private helpers for the unit tests to target directly.
- [ ] Verify: `pnpm --dir services/worker test && pnpm --dir apps/api test` green; manual end-to-end run with a 150+pp fixture thesis produces >=2 findings with real page/section ids.
- [ ] Rollback: revert `cag_review.py`, `main.py`'s contract, `review-orchestrator.mjs`'s loop, and all 4 rewritten test suites together (they are one coupled behavior change, not independently revertable).

### 9. Role-based provider assignment

- [ ] RED: `apps/api/tests/llm-provider-config-migration.test.mjs`-style assertions for `0004_llm_provider_role.sql` (two simultaneously-active roles coexist; a second active `judgment` row is rejected by `uq_llm_provider_config_one_active_per_role`) and `0005_review_run_triage_provenance.sql` (nullable `triage_provider_name`/`triage_model_id`). `provider-config-repository.test.mjs`/`admin-contract.test.mjs` cases: `getActiveProvider("triage")` returns `null` without erroring; `activate()` only deactivates same-role rows; create validates `role in ['judgment','triage']`; PATCH with a `role` field is rejected (422). `apps/web/tests/admin-providers-view.test.mjs` case for the role select/column payload shape (spec: all `llm-provider-admin` MODIFIED Requirements).
- [ ] GREEN: Write `0004_llm_provider_role.sql`/`0005_review_run_triage_provenance.sql` (UP/DOWN per D7); `provider-config-repository.mjs`'s `getActiveProvider(role="judgment")`/`activate(id)`/`toMaskedView` gain `role`; `admin-contract.mjs` create accepts optional `role` (default `judgment`), PATCH strips/rejects it; `live-review-pipeline.mjs` resolves `judgment` (required, missing → "no active judgment provider configured") and `triage` (optional, missing → `null`, no error) and forwards both plus dual provenance to the orchestrator; `admin-providers-view.ts`/`-page.ts` gain the role select (create-only), table column, and `buildUpdateProviderPayload` never emits `role`.
- [ ] TRIANGULATE: Activating a new `judgment` provider leaves the active `triage` provider untouched, and vice versa. `0004`'s DOWN fails loudly if two roles are simultaneously active (documented, not silently destructive).
- [ ] REFACTOR: Share role-validation between create/update handlers.
- [ ] Verify: `pnpm --dir apps/api test && pnpm --dir apps/web test` green; `migrate.mjs up`/`down` cycle against dockerized pg for both new migrations; manual `pnpm --dir apps/web start` shows the role column/select.
- [ ] Rollback: `migrate.mjs down` for `0005` then `0004`; revert `provider-config-repository.mjs`/`admin-contract.mjs`/`live-review-pipeline.mjs`/`admin-providers-view.ts`/`-page.ts`; today's single global `is_active` behavior returns (existing rows default to `judgment`).

### 10. Real `DeepSeekProvider` wired as `triage`

- [ ] RED: New `services/worker/tests/test_deepseek_provider.py` — request shape (`POST {DEEPSEEK_BASE_URL}/chat/completions`, `Authorization: Bearer <key>`, `model/messages/max_tokens/temperature=0/stream=false`), response mapping (`choices[0].message.content` → text, `usage.prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` → `cache_read_tokens`/`cache_write_tokens`), `DeepSeekProviderConfigError`/`DeepSeekProviderUpstreamError` both `LLMProviderError`. `test_review_endpoint.py`/`test_cag_review.py` case: triage provider errors → `suspect=True` (fail OPEN), judgment review still runs and completes (Threat Matrix: Credential Handling — triage key never appears in logs/`error_summary`, mirroring the existing judgment-key assertion).
- [ ] GREEN: Create `services/worker/app/providers/deepseek_provider.py` (`httpx` only, lazy key from arg-then-`DEEPSEEK_API_KEY` env, mirrors `AnthropicProvider`'s error-raising-inside-`complete()` pattern); wire it into the provider factory replacing the `UnimplementedProvider` branch for `deepseek`; add the new error-to-500 branch in `main.py`'s except-ladder; `cag_review.py`'s loop calls `triage_says_suspect(chunk)` before the judgment call when `triage_provider` is present.
- [ ] TRIANGULATE: Missing `DEEPSEEK_API_KEY` and no explicit key → `DeepSeekProviderConfigError`, not a silent skip; a real upstream 4xx/5xx → `DeepSeekProviderUpstreamError`, fails open into judgment (never blocks the run).
- [ ] REFACTOR: N/A — single new provider module.
- [ ] Verify: `pnpm --dir services/worker test` green; manual triage-role run with a real `DEEPSEEK_API_KEY` shows reduced judgment-call count via `stats.triage_skipped`.
- [ ] Rollback: revert `deepseek_provider.py` and the factory branch; DeepSeek returns to `UnimplementedProvider`, judgment-only review continues working.

## Suggested PR Chain

1. **PR1 — Section detection + persistence**: Work Units 1–3.
2. **PR2 — Deterministic rules**: Work Units 4–5.
3. **PR3 — DOCX→PDF conversion**: Work Unit 6.
4. **PR4 — Cache-aware provider protocol (breaking)**: Work Unit 7.
5. **PR5 — Chunked multi-finding review loop + contract**: Work Unit 8.
6. **PR6 — Role-based provider assignment**: Work Unit 9.
7. **PR7 — Real DeepSeek triage**: Work Unit 10.
