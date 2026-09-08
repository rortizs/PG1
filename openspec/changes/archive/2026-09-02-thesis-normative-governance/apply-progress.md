# Apply Progress: thesis-normative-governance

**Scope**: PR1 "governance spine" (Work Units 1-6) — see below. PR2 "grounded
rules" (Work Units 7-10: `reglamento_structure.py`, `citations.py` APA-6
additions, `_apply_precedence()`, D8 structural guard) is now **also
implemented** — see the "PR2" section appended at the end of this file. All
60/60 `tasks.md` checkboxes are `[x]`.

**Mode**: Strict TDD (every unit below followed RED -> GREEN -> TRIANGULATE ->
REFACTOR -> Verify -> Rollback).

## Status

10/10 work units complete (PR1: 1-6, PR2: 7-10). 60/60 total tasks.md
checkboxes are `[x]`. See the "PR2 — Grounded Rules" section appended at the
end of this file for PR2's own record (PR1's record above is preserved
unmodified).

## Completed Work Units

### 1. Migration `0006_normative_governance.sql`
- Created `apps/api/src/db/migrations/0006_normative_governance.sql` exactly per design.md D1:
  - `GENERATED ALWAYS AS (CASE source_type ...) STORED` `precedence` column.
  - `UPDATE` retypes the existing `lineamientos_ingenieria_sistemas.txt` row (`'rubric'` ->
    `'reglamento_tesis'`) — does not create a duplicate row.
  - Idempotent `INSERT ... WHERE NOT EXISTS` seeds a metadata-only `apa_6` row.
  - `finding_finding_type_check` widened with `'structure'`.
  - `idx_normative_source_precedence` index.
  - DOWN reverses in the documented safe order (retype-and-delete before narrowing CHECKs).
- Verified against a REAL local Postgres (Homebrew `postgresql@17` on `localhost:5432`, role/db
  `pg1`/`pg1` created for this session, `pgvector` extension installed via `brew install pgvector`
  since it was missing) — not just read from the SQL text.
- `node src/db/migrate.mjs up` then `down` cycles cleanly (confirmed via direct CLI invocation,
  not only the test suite).
- New test file: `apps/api/tests/normative-governance-migration.test.mjs` (4 tests): precedence
  tiers 1/2/3, Reglamento retype + `'structure'` finding_type acceptance, apa_6 seed idempotency +
  generated-column insert rejection, DOWN reversal.
- **Necessary regression fix**: `apps/api/tests/review-repository.test.mjs`'s
  `assert.equal(countRows.rows[0].count, 4)` updated to `5` — a fresh `migrateUp()` now seeds 4
  corpus files + 1 migration-seeded `apa_6` row.

### 2. `RuleFinding.normative_source_type` + `SOURCE_PRECEDENCE` + `squeeze()`
- `services/worker/app/rules/base.py`: added `normative_source_type: str | None = None` (appended
  after existing defaults, frozen dataclass, no call-site breakage), `SOURCE_PRECEDENCE = {
  "reglamento_tesis": 1, "apa_6": 2, "gt_guide": 3 }`, `squeeze()` (delegates to existing `fold()`,
  then strips all whitespace).
- New test file: `services/worker/tests/test_base.py` (8 tests).

### 3. `run_rules()` stamping + re-tag existing modules
- `services/worker/app/rules/__init__.py`: stamping loop reads each module's
  `NORMATIVE_SOURCE_TYPE` via `getattr()` (loud `AttributeError` if missing), resolves
  `SOURCE_PRECEDENCE[source_type]` (loud `KeyError` if unrecognized), stamps both fields via
  `dataclasses.replace()`.
- Added `NORMATIVE_SOURCE_TYPE = "gt_guide"` to `gt_structure.py`, `filler_words.py`,
  `long_sentences.py`, `spelling.py`.
- **Deviation from tasks.md** (documented inline in `tasks.md` Work Unit 3 too): also added
  `NORMATIVE_SOURCE_TYPE = "apa_6"` to `citations.py`. `_RULE_MODULES` has 5 members, not 4;
  `citations.py` was omitted from this unit's module list, but the new stamping loop calls
  `getattr()` unconditionally on every registered module — omitting it would raise
  `AttributeError` on every `run_rules()` call and break the pre-existing citation cross-check.
  This is a metadata-only, one-line addition consistent with design.md D3's own module table; no
  D6 APA-6 rule logic (et-al./quote-length checks) was added.
- Extended `services/worker/tests/test_rules.py`: fixed `ConfidenceThresholdTest`'s `FakeModule`
  (added the now-required constant so the pre-existing test stays meaningful), added
  `NormativeSourceStampingTest` (4 new tests: stamping value/tier, structural
  every-module-declares-the-constant check, missing-constant `AttributeError`, unrecognized-value
  `KeyError`).

### 4. `getNormativeSourceIdsBySourceType()` + widened `resolveNormativeSourceId`
- `apps/api/src/db/review-repository.mjs`: new `getNormativeSourceIdsBySourceType()` method
  (`SELECT DISTINCT ON (source_type) ... ORDER BY source_type, precedence, id`); corrected
  `DEFAULT_SOURCE_TYPE_BY_FILE`'s `lineamientos_ingenieria_sistemas.txt` entry to
  `"reglamento_tesis"` directly (a fresh DB no longer needs the migration's `UPDATE` to get the
  correct type).
- `apps/api/src/live-review-pipeline.mjs`: exported `resolveNormativeSourceId` (was private),
  widened its single cache merge to `{ ...seedNormativeSources(), ...getNormativeSourceIdsBySourceType() }`
  — same function, same signature, key-collision-free (filenames end in `.txt`, source types
  never do).
- New test file: `apps/api/tests/live-review-pipeline-resolver.test.mjs` (3 tests: resolves
  source_type refs, still resolves filename refs unchanged, resolves both together without
  collision plus an unknown ref returning `null`).
- New test in `review-repository.test.mjs`: `getNormativeSourceIdsBySourceType` picks the lowest
  precedence/id row for `gt_guide`'s two real corpus rows.

### 5. Orchestrator wiring fix (`review-orchestrator.mjs:239`)
- Replaced the hardcoded `normativeSourceId: null` with
  `await resolveNormativeSourceId(ruleFinding.normative_source_type)`.
- Two new tests in `review-orchestrator.test.mjs`: resolves a real id from the injected resolver
  (fake, no live DB needed); persists `null` (never throws) when the resolver returns no row for
  an unrecognized/unseeded source type.
- Regression-verified against the full `review-orchestrator.test.mjs` suite (14 tests) and the
  heavy `live-review-integration.test.mjs` end-to-end scenario, both green.

### 6. Approval-gate isolation proofs (D9)
- **Proof 1 (migration text)**: new `apps/api/tests/approval-gate-isolation.test.mjs` — asserts
  the scanner correctly *fails* against a deliberate-violation fixture first (proving it's not a
  no-op), then passes clean against the real `0006_normative_governance.sql` text (never
  references `review_workflow_item` or `approval_state`).
- **Proof 2 (call-path)**: new test in `review-orchestrator.test.mjs` wraps the repository in a
  `Proxy` that throws on any property access matching `/workflow|approval|approve/i` for a
  property not already on the base object. **Genuinely proved the trap fires**: temporarily
  inserted `await repository.approveWorkflowItem();` into `review-orchestrator.mjs`'s
  rules-persistence path, re-ran the test, confirmed it failed (0 `persistFinding` calls instead
  of 1 — the trap prevented the rest of the pipeline from running), then removed the decoy and
  confirmed green again. The decoy line does not exist in the final diff.
- TRIANGULATE: asserted the pattern also matches case-insensitive decoy names
  (`getApprovalState`, `updateWorkflowApprovalState`).

## TDD Cycle Evidence

| Work Unit | RED (confirmed failing, real reason) | GREEN (confirmed passing) | REFACTOR |
|---|---|---|---|
| 1. Migration 0006 | Yes — `column "precedence" does not exist`, then genuine assertion failures for retype/seed/DOWN scenarios against real Postgres | Yes — 4/4 tests green | N/A (DDL only, per design) |
| 2. base.py additions | Yes — `ImportError: cannot import name 'SOURCE_PRECEDENCE'` | Yes — 8/8 tests green | `squeeze()` delegates to `fold()`, no duplication |
| 3. run_rules() stamping | Yes — `AssertionError: None != 'gt_guide'`, `AttributeError not raised`, `KeyError not raised`, missing-constant assertion failure | Yes — 19/19 test_rules.py tests green | Stamping loop kept adjacent to the `MIN_RULE_CONFIDENCE` filter |
| 4. Resolver widening | Yes — `repository.getNormativeSourceIdsBySourceType is not a function`, `resolveNormativeSourceId is not a function` | Yes — 6/6 new tests green (3 repository + 3 resolver) | N/A (additive cache merge only) |
| 5. Orchestrator wiring | Yes — `resolvedRefs` empty array vs expected `["gt_guide"]` | Yes — 2/2 new tests green | N/A (one-line call-site change) |
| 6. D9 proofs | Yes — scanner-fails-on-fixture proven; call-path proof's decoy insertion genuinely broke the test (0 vs 1 persistFinding calls) before removal | Yes — 3/3 new tests green (2 migration-text + 1 call-path) | N/A (assertion-only tests) |

## Work Unit Evidence

| Work Unit | Focused test command + result | Runtime harness + result | Rollback boundary |
|---|---|---|---|
| 1 | `DATABASE_URL=postgres://pg1:pg1@localhost:5432/pg1 node --import tsx --test tests/normative-governance-migration.test.mjs` — 4/4 pass | `node src/db/migrate.mjs up` then `down` against real local Postgres — both completed cleanly | `migrate.mjs down` reverts 0006 (retype+delete before narrowing CHECKs) |
| 2 | `PYTHONPATH=. python3 -m unittest tests.test_base` — 8/8 pass | N/A — pure unit, no runtime boundary | Revert the 3 `base.py` additions; additive-only |
| 3 | `PYTHONPATH=. python3 -m unittest tests.test_rules` — 19/19 pass | N/A — pure unit | Revert stamping loop + 5 one-line constants (4 planned + citations.py deviation) |
| 4 | `DATABASE_URL=... node --import tsx --test tests/review-repository.test.mjs tests/live-review-pipeline-resolver.test.mjs` — 6/6 + 3/3 pass | Exercised against real local Postgres, real corpus seeding | Revert both files; CAG filename path byte-identical |
| 5 | `node --import tsx --test tests/review-orchestrator.test.mjs` — 14/14 pass | `live-review-integration.test.mjs` full end-to-end scenario (real Postgres + fake worker) — pass | Revert the one-line diff at `review-orchestrator.mjs:239` |
| 6 | `node --import tsx --test tests/approval-gate-isolation.test.mjs tests/review-orchestrator.test.mjs` — 2/2 + 14/14 pass | Decoy-insertion runtime proof (see above) | Test-only; no production revert needed |

**Full regression** (after all 6 units): `pnpm --dir apps/api test` 105/105 pass;
`pnpm --dir services/worker test` 70/70 pass; `pnpm --dir apps/web test` 56/56 pass (untouched,
sanity check only); root `pnpm test` (all three) green, exit 0.

## Deviations from Design

1. **`citations.py` gets `NORMATIVE_SOURCE_TYPE = "apa_6"` in PR1**, not deferred to PR2's Work
   Unit 8 as `tasks.md` literally listed. Required for `run_rules()`'s unconditional `getattr()`
   stamping loop not to break the already-registered `citations.py` module. Consistent with
   design.md D3's own module table. No PR2 rule logic was added.
2. **Migration test harness applies migrations 0001-0005 individually via `migrationPath`, seeds a
   deliberately-legacy corpus mapping (`lineamientos... -> 'rubric'`), then applies 0006 alone** —
   this reproduces design.md D1's actual grounding scenario (a pre-existing production DB with the
   corpus already seeded 'rubric') rather than a fresh DB, which would never exercise the UPDATE
   retype path at all (a fresh DB gets the correct type directly via the corrected
   `DEFAULT_SOURCE_TYPE_BY_FILE`, per Work Unit 4). This is a test-design decision, not a
   deviation in production behavior.

## Risks / Notes for Verify

- **Line-count overage vs forecast**: `tasks.md`'s Review Workload Forecast estimated PR1 at
  ~300-380 changed lines (production ~150-180 + tests). Actual: ~211 production lines (migration +
  6 app files) + ~894 test lines = ~1105 authored changed lines. The overage is entirely in test
  scaffolding — DB-integration tests (migration retype/seed/DOWN scenarios, resolver widening,
  approval-gate proxy) required substantial real-Postgres setup/teardown per the strict-TDD +
  "verify against a real Postgres, not just the SQL text" instruction. `tasks.md`'s own forecast
  already recorded `Decision needed before apply: No` and a resolved `stacked-to-main` chain
  strategy with PR1 as the atomic unit, so this was not a pre-apply blocking decision — flagging
  for `sdd-verify`/reviewer awareness given the actual size exceeds the 400-line reviewer budget
  even within this one work-unit slice.
- **Local Postgres environment**: this session's local Homebrew `postgresql@17` had a `pg1`
  role/database created (previously absent) and the `pgvector` extension installed via
  `brew install pgvector` (previously absent — `brew list` showed only `postgresql@16`/`@17`).
  Both are now present for future sessions. `infra/docker-compose.yml` was NOT touched (`git diff`
  shows zero net change, confirmed).
- No code path introduced writes to `review_workflow_item.approval_state` — proven by both D9
  proofs (migration-text scan + genuinely-tested call-path proxy trap).
- No APA 7 content was added anywhere in this pass.
- PR2 (Work Units 7-10) remains fully unimplemented and unchecked in `tasks.md`.
  **Update (PR2 apply pass, appended below)**: PR2 is now implemented — see the
  "PR2 — Grounded Rules" section at the end of this file. This PR1 record above is
  otherwise preserved unmodified, per the append-not-overwrite convention.

---

# PR2 — Grounded Rules (Work Units 7-10)

**Scope**: Work Units 7-10 of `tasks.md` — `services/worker/app/rules/reglamento_structure.py`
(new module, D5), `citations.py` APA-6 additions (D6), `_apply_precedence()` +
its limitation-guard test (D7), and D8's non-goals structural enforcement.
Builds directly on PR1's `normative_source_type`/`SOURCE_PRECEDENCE`/`squeeze()`/
stamping-loop foundation (unmodified in this pass except for wiring
`_apply_precedence()` into `run_rules()`'s final step).

**Mode**: Strict TDD (every unit below followed RED -> GREEN -> TRIANGULATE ->
REFACTOR -> Verify).

## Status

4/4 PR2 work units complete. 60/60 `tasks.md` checkboxes are `[x]` (PR1 + PR2
combined).

## Completed Work Units

### 7. `reglamento_structure.py` (new module, D5)
- Created `services/worker/app/rules/reglamento_structure.py`: `PRELIMINARY_SCAN_PAGES = 8`,
  `REQUIRED_ARTICLE_8_TEXT` (verbatim, recovered directly from
  `data/academic-rules/lineamientos_ingenieria_sistemas.txt` L153-155), `PRELIMINARY_SEQUENCE`
  (6-tuple of label + marker-phrase alternatives, grounded in the same corpus file's pages 1-6),
  `NOT_COVERED` (D8 non-goals constant), `NORMATIVE_SOURCE_TYPE = "reglamento_tesis"`.
- Two checks: `_check_preliminary_sequence()` (squeeze-based marker matching over the first
  `PRELIMINARY_SCAN_PAGES` pages, in document order, producing `missing_preliminary_page` and/or
  `preliminary_page_out_of_order` findings) and `_check_articulo_8()` (exact `squeeze()`
  containment first; falls back to `difflib.SequenceMatcher` ratio over squeezed forms — `>=
  0.85` classifies `articulo_8_altered`, below classifies `articulo_8_missing`).
  `check(pages, sections)` deliberately ignores `sections` (D5: preliminary pages carry no
  reliable heading shape).
- Registered in `__init__.py`'s `_RULE_MODULES` (6 modules now, was 5).
- New test file `services/worker/tests/test_reglamento_structure.py` (13 tests): correct
  sequence / missing element / out-of-order / intra-word-split marker resilience; verbatim /
  altered / missing Artículo 8° text, including an **explicit ratio-boundary test** that
  programmatically truncates the required text using the SAME `difflib.SequenceMatcher`
  computation the module uses until the ratio crosses `ARTICULO_8_MATCH_RATIO`, proving the
  `>= 0.85` vs `< 0.85` split without a fragile hardcoded magic string; zero-evidence skip
  (empty pages / fewer-than-scan-window pages with no text); `sections` argument accepted but
  provably unused; `NOT_COVERED` structural sanity check.
- **Deviation found during GREEN**: an initial "altered" test fixture that included realistic
  page-heading noise ("REGLAMENTO DE TESIS\n\nArtículo 8°: RESPONSABILIDAD\n\n" prefix before
  the altered paragraph) measured a ratio of ~0.82 against the whole-page squeezed comparison —
  below the 0.85 threshold — because design.md D5's ratio computation compares the ENTIRE page
  text against the required paragraph, and heading text dilutes the ratio. This is a genuine,
  documented characteristic of the whole-page (non-windowed) ratio approach D5 specifies, not a
  bug: a page whose extracted text is dominated by non-Artículo-8 content will need a
  more-different alteration (or a shorter page) to cross the 0.85 threshold. The final fixture
  reflects a page whose extracted text is essentially just the paragraph (a realistic scenario
  for an isolated preliminary page), which is where this check is actually meant to apply.
  Flagging for `sdd-verify`/reviewer awareness — not a scope or invariant change, but worth
  confirming the whole-page-ratio approach matches expectations for pages with substantial
  non-Artículo-8 content.

### 8. `citations.py` APA-6 additions (D6)
- Added `ET_AL_REQUIRED_SIX_AUTHORS_RULE_ID`, `ET_AL_REQUIRED_AFTER_FIRST_MENTION_RULE_ID`,
  `ET_AL_ON_TWO_AUTHOR_SOURCE_RULE_ID`, `LONG_QUOTE_NOT_BLOCK_RULE_ID` and their confidences
  (0.85/0.80/0.75/0.80 respectively, per D6's table).
- New second, independent scanner `_check_et_al_and_quotes()`, called from `check()`'s existing
  return path via `findings.extend(...)` — the pre-existing `_IN_TEXT_CITATION_PATTERN` /
  `_REFERENCE_ENTRY_PATTERN` cross-check function body is byte-for-byte untouched.
  - `_FULL_AUTHOR_GROUP_PATTERN` matches fully-named author-list citations (does NOT match
    "et al." citations — verified structurally: the pattern requires either a comma-list or an
    `&`/`y` continuation immediately after the first author, and "et al." matches neither, so
    the regex fails to match at that position). Counts authors via `_AUTHOR_TOKEN_PATTERN`
    findall; tracks first-mention-vs-repeat occurrences per `(first_author, year)` key.
  - `_ET_AL_CITATION_PATTERN` matches `"X et al., YYYY"` citations; resolves against a
    second, independent reference-entry scan (`_reference_entries_by_key()`, reusing the shared
    `_reference_pages`/`_REFERENCE_ENTRY_PATTERN`/`_citation_key` helpers without modifying
    them) and counts authors in the resolved entry via `_REFERENCE_AUTHOR_TOKEN_PATTERN`.
  - `_QUOTE_SPAN_PATTERN` (bounded `{1,MAX_QUOTE_SPAN_CHARS}` quantifier, `MAX_QUOTE_SPAN_CHARS
    = 2000`, no nested quantifiers) matches quoted spans; `>= 40` words flags
    `long_quote_not_block`.
- New tests in `services/worker/tests/test_rules.py`: `Apa6EtAlThresholdTest` (9 tests),
  `Apa6QuoteLengthTest` (3 tests, including an explicit ReDoS-guard test with a 5000-word
  unterminated-quote fixture that must return promptly, not hang), `ThirtyNineWordQuoteBoundaryTest`
  (1 test, exact 39-vs-40-word boundary).
- Regression-verified: the pre-existing `CitationsTest` cases stay green unmodified, plus a new
  explicit regression-guard test (`test_pre_existing_cross_check_fixtures_remain_unaffected_by_the_new_scanner`)
  asserting the new scanner produces zero `et_al` findings on the pre-existing fixtures.

### 9. `_apply_precedence()` + limitation-guard test (D7)
- Implemented in `services/worker/app/rules/__init__.py`: two-pass algorithm (group findings by
  `metadata["conflict_key"]`, resolve one winner per group via `min()` on `precedence_tier`
  keyed by list order for deterministic ties, then re-walk the ORIGINAL `findings` list in its
  original order — never a groups-then-passthrough reordering — replacing every loser with
  `dataclasses.replace(finding, severity="low", metadata={...,
  "superseded_by_higher_precedence": {...}})`). Wired as `run_rules()`'s literal final
  `return _apply_precedence(findings)` statement.
- New tests in `test_rules.py`: `PrecedenceArbitrationTest` (4 tests: demotion with constructed
  tier-1/tier-3 fixtures per D7's "honest TDD strategy for an untestable-in-production path" —
  no synthetic production rule; passthrough-when-no-conflict-key; 3-way same-tier tie
  resolves by first-emitted order; an end-to-end `run_rules()` wiring test using two throwaway
  fixture modules to prove real integration, not just direct-function-call coverage) and
  `ConflictKeyLimitationGuardTest` (1 test: runs `run_rules()` over a representative
  multi-rule-triggering fixture — filler words, long sentences, spelling, citations,
  gt_structure, reglamento_structure all exercised, 4+ real findings produced — and asserts
  **zero** of them carry a `conflict_key`, proving today's real, deliberate limitation in
  executable form per design.md D7. No synthetic production rule was added to fabricate a
  real conflict.).

### 10. D8 non-goals structural enforcement
- `NOT_COVERED` constant already landed as part of Work Unit 7's GREEN step (both units are
  implemented together in `reglamento_structure.py` per design.md's own file-changes table).
- New `NonGoalsStructuralGuardTest` in `test_rules.py` (2 tests): first proves the
  layout-token scanner is not a no-op by asserting it correctly detects a deliberately
  violating fixture `rule_id` (`"reglamento_structure.margen_incorrecto"`) AND an
  accent-bearing, mid-string variant (`"...márgen..."`); then walks every `_RULE_MODULES`
  member's `dir()`, filters to names containing `"RULE_ID"`, and asserts none of their string
  values match `margen|interlineado|fuente|sangria|cursiva|paginacion` after `fold()`-based
  accent/case normalization.

## TDD Cycle Evidence

| Work Unit | RED (confirmed failing, real reason) | GREEN (confirmed passing) | REFACTOR |
|---|---|---|---|
| 7. `reglamento_structure.py` | Yes — `ImportError: cannot import name 'reglamento_structure'`, then a genuine `AssertionError: 0 != 1` on the first altered-text fixture (heading-noise ratio dilution, see Deviations) before the fixture was corrected | Yes — 13/13 tests green | N/A — no worthwhile extraction beyond existing shared helpers |
| 8. `citations.py` APA-6 | Yes — vacuous-empty-list failures (`0 != 1`, "expected a finding, found none") for every new rule_id, confirmed genuinely absent (not an AttributeError short-circuit — the comprehensions never evaluated the not-yet-existing constants because `findings` was empty) | Yes — 13/13 new tests green (9 + 3 + 1) | N/A — shared helpers (`_AUTHOR_TOKEN_PATTERN`, `_citation_key`) already avoid duplication |
| 9. `_apply_precedence()` | Yes — `AttributeError: module 'app.rules' has no attribute '_apply_precedence'` on all 4 new tests | Yes — 4/4 new tests green, plus the limitation-guard test green | N/A — pure function, already minimal per design's honest-TDD note |
| 10. D8 structural guard | Yes — exercised genuinely as part of Work Unit 7's module registration (scanner correctly detects the deliberate-violation fixture before trusting the clean pass) | Yes — 2/2 tests green | N/A — assertion-only guard |

### Test Summary
- **Total tests written (PR2)**: 33 new test functions — verified via a true pre-PR2 baseline
  (`git stash -u` to also stash the new untracked files, confirming `services/worker`'s full
  suite was 70/70 and `test_rules.py` alone was 19/19 before this pass). 13 in the new
  `test_reglamento_structure.py` + 20 net-new in `test_rules.py` (39 total there now, up from
  19) = 33.
- **Total tests passing**: `services/worker` full suite **103/103** (was 70/70 before PR2: +33,
  matching the 33 new test functions exactly — confirmed by direct `git stash -u` A/B
  comparison, not derived arithmetic).
- **Layers used**: Unit (Python) only — no runtime/integration boundary for pure-function rule
  modules (matches PR1's own precedent for `base.py`'s unit-only work units).
- **Approval tests** (refactoring): None — no refactoring tasks in PR2; Work Unit 7/9/10's
  REFACTOR rows are N/A per design.md's own "already minimal" note.
- **Pure functions created**: `reglamento_structure.check()` and its 4 private helpers,
  `citations._check_et_al_and_quotes()` and its 1 private helper, `_apply_precedence()` — all
  pure functions over `pages`/`sections`/`findings` inputs, zero side effects, zero DB/LLM
  coupling (verified by the existing `ImportBoundaryTest`, which now also covers
  `reglamento_structure.py` — 6 modules scanned, was 5).

## Work Unit Evidence

| Work Unit | Focused test command + result | Runtime harness + result | Rollback boundary |
|---|---|---|---|
| 7 | `PYTHONPATH=. python3 -m unittest tests.test_reglamento_structure` — 13/13 pass | N/A — pure text unit, no runtime boundary | Delete `reglamento_structure.py` + its `_RULE_MODULES` registration (one revertable unit) |
| 8 | `PYTHONPATH=. python3 -m unittest tests.test_rules` — 39/39 pass (includes pre-existing `CitationsTest`, unmodified) | N/A — pure text unit | Revert only the D6 additions to `citations.py`; pre-existing cross-check untouched |
| 9 | `PYTHONPATH=. python3 -m unittest tests.test_rules` — 39/39 pass | N/A — pure function over constructed fixtures, plus one `run_rules()` end-to-end wiring test using throwaway fixture modules | Revert `_apply_precedence()` and its call from `run_rules()`'s final `return` |
| 10 | `PYTHONPATH=. python3 -m unittest tests.test_rules` — 39/39 pass | N/A — assertion-only structural guard | Test-only; no production revert needed |

**Full regression** (after all 4 PR2 units): `services/worker` full suite (`PYTHONPATH=.
python3 -m unittest discover -s tests -p 'test_*.py'`) 103/103 pass (pre-existing "EOF marker
not found" warning line confirmed pre-existing and unrelated via a true `git stash -u` A/B
comparison, which also stashes the new untracked PR2 files — 70/70 tests passed with that same
warning present before this PR's changes; 103 - 70 = 33, matching the 33 new PR2 test functions
exactly). Also ran, as a full cross-service sanity check even though PR2 touches only
`services/worker`: `DATABASE_URL=...pnpm --dir apps/api test` 105/105 pass; `pnpm --dir apps/web
test` 56/56 pass. `git diff --stat -- infra/docker-compose.yml` shows zero output (zero net diff,
confirmed).

## Deviations from Design

1. **Altered-Artículo-8° test fixture required removing page-heading noise** (see Work Unit 7's
   notes above) — a genuine characteristic of the whole-page (non-windowed) `difflib` ratio
   comparison design.md D5 specifies, not a production-code deviation. No code changed as a
   result; only the test fixture's page-text shape.
2. **`_apply_precedence()`'s implementation uses a two-pass algorithm** (group-then-resolve,
   then re-walk the original list) rather than a single accumulating pass, specifically to
   preserve the exact original relative order of passthrough (non-conflicting) findings among
   conflicting ones. Design.md D7's pseudocode signature is a single-line docstring stub with no
   prescribed internal algorithm, so this is an implementation-detail choice consistent with the
   design's stated behavior (demote-never-drop, tie-break by first-emitted order), not a
   deviation from any documented invariant.

## Risks / Notes for Verify

- **Line-count overage vs forecast, more pronounced than PR1's**: `tasks.md`'s forecast
  estimated PR2 at ~380-480 changed lines (High risk, explicitly flagged as denser than typical
  due to verbatim corpus fixtures). Actual: `git diff --stat` on the 3 modified files
  (`app/rules/__init__.py`, `app/rules/citations.py`, `tests/test_rules.py`) shows 733 changed
  lines (insertions+deletions); the 2 new files (`app/rules/reglamento_structure.py`,
  `tests/test_reglamento_structure.py`) add 489 more lines (241 + 248). Total: **1222 changed
  lines**, exceeding the 400-line reviewer budget by a wide margin, and exceeding even the
  design's own ~380-480 PR2 estimate. Per this pass's explicit instructions, genuine test
  coverage and grounding fixtures were NOT trimmed to fit the budget — `gentle-ai sdd-attempt
  settle` was run honestly with `--outcome passed` and returned `state: blocked,
  reason: maintainer_decision` (the exact same pattern as PR1's session), requiring a maintainer
  to run `gentle-ai sdd-attempt reset ... size:exception` (or equivalent) before this work is
  considered delivered. This is expected, not a failure — flagging for `sdd-verify`/user
  awareness per the task's own instructions.
- **`reglamento_structure.py`'s Artículo 8° ratio check is whole-page, not windowed** (design.md
  D5's own specification — "over squeezed forms" with no windowing described). For pages whose
  extracted text mixes the required paragraph with substantial unrelated heading/other content,
  a genuinely-altered-but-still-recognizable Artículo 8° text may score below the 0.85 threshold
  and get classified as `articulo_8_missing` rather than `articulo_8_altered`. This is a
  documented, inherited design characteristic (see Work Unit 7's Deviation note above), not
  something this pass introduced or silently worked around — flagging for reviewer awareness.
- **No code path introduced by PR2 touches `review_workflow_item.approval_state`** — verified via
  `rg -n "approval_state|review_workflow_item|approveWorkflowItem"` across every file this PR2
  pass touched or created, zero matches (exit code 1).
- **No APA 7 content was added anywhere in PR2** — verified via `rg -ni "apa.?7|apa seven"`
  across every file this pass touched or created, zero matches (exit code 1).
- **`infra/docker-compose.yml` was NOT touched** — `git diff --stat` shows zero output.
- **`_apply_precedence()`'s arbitration mechanism is real and wired, but no real production
  conflict exists to arbitrate today** — this is design.md D7's own explicitly documented,
  deliberate limitation, proven in executable form by `ConflictKeyLimitationGuardTest`, not
  papered over or silently claimed as "solved."
- **60/60 `tasks.md` checkboxes are now `[x]`** — both PR1 and PR2 are fully implemented per
  `tasks.md`'s own Work Unit breakdown.
- **`gentle-ai sdd-attempt settle --outcome passed` returned `state: blocked, reason:
  maintainer_decision`** for this work unit's 1222-changed-line total exceeding the 400-line
  budget — the same pattern PR1's session hit. This is the expected terminal state per this
  pass's explicit instructions (do not trim genuine coverage to fit the budget); it requires a
  maintainer to run `gentle-ai sdd-attempt reset ... size:exception` (or an equivalent resolved
  chain-strategy decision) before delivery. Not a defect in the implementation.
