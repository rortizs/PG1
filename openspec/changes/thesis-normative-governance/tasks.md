# Tasks: Thesis Normative Governance Harness

> Size note: this artifact exceeds the generic 530-word budget, following the same house
> exception `design.md` already claims and the exact RED/GREEN/TRIANGULATE/REFACTOR/Verify/
> Rollback convention established by `precise-thesis-review-pipeline/tasks.md`. Strict TDD mode
> requires each RED row to state a genuine, checkable failure mode, not a placeholder — that
> requires prose, not a one-line checklist.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR1 ~300-380 (production ~150-180 + tests) · PR2 ~380-480 (production ~230-280 + tests, dense with verbatim corpus fixtures) |
| 400-line budget risk | PR1: Medium · PR2: High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 governance spine → PR2 grounded rules |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Design's own size forecast (`design.md`, "Size forecast for sdd-tasks") already flags
~350-450 authored production lines plus a comparable test volume for the whole change as a
single PR, "likely to exceed the 400-line review budget," and recommends exactly the two
slices used here. PR2 carries the higher risk: `reglamento_structure.py` embeds literal
verbatim corpus text (`REQUIRED_ARTICLE_8_TEXT`, `PRELIMINARY_SEQUENCE` marker phrases) and its
test fixtures quote the same corpus at comparable length, so its line count is denser than a
typical logic-only PR of similar scope.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Migration `0006_normative_governance.sql` (D1/D2) | PR1 | `pnpm --dir apps/api test` | dockerized pg, `migrate.mjs up`/`down` | `migrate.mjs down` for 0006 |
| 2 | `RuleFinding.normative_source_type`, `SOURCE_PRECEDENCE`, `squeeze()` in `base.py` (D3) | PR1 | `pnpm --dir services/worker test` | N/A — pure unit | revert `base.py`'s 3 additions |
| 3 | `run_rules()` stamping + re-tag 4 existing modules (D3) | PR1 | `pnpm --dir services/worker test` | N/A — pure unit | revert stamping loop + 4 one-liners |
| 4 | `getNormativeSourceIdsBySourceType()` + widened `resolveNormativeSourceId` (D4) | PR1 | `pnpm --dir apps/api test` | dockerized pg | revert both files |
| 5 | Orchestrator wiring fix at `review-orchestrator.mjs:239` (D4) | PR1 | `pnpm --dir apps/api test && pnpm --dir services/worker test` | end-to-end run against dockerized pg + local worker | revert the one-line diff |
| 6 | Approval-gate isolation proofs (D9) | PR1 | `pnpm --dir apps/api test` | dockerized pg | test-only; no production revert needed |
| 7 | `reglamento_structure.py` new module (D5) | PR2 | `pnpm --dir services/worker test` | N/A — pure text unit | delete module + its `_RULE_MODULES` registration |
| 8 | `citations.py` APA-6 additions (D6) | PR2 | `pnpm --dir services/worker test` | N/A — pure text unit | revert D6 additions only |
| 9 | `_apply_precedence()` + limitation-guard test (D7) | PR2 | `pnpm --dir services/worker test` | N/A — pure unit over constructed fixtures | revert `_apply_precedence()` and its `run_rules()` call |
| 10 | D8 non-goals structural enforcement test | PR2 | `pnpm --dir services/worker test` | N/A — assertion-only guard | test-only; no production revert needed |

## Scope Guard

- No layout-derived finding, ever (D8) — margins, spacing, font, pagination position, hanging
  indent, italics stay unchecked until a layout-aware extraction rework lands. `rule_id`
  constants must never contain `margen|interlineado|fuente|sangria|cursiva|paginacion`.
- No code path introduced by this change may read or write
  `review_workflow_item.approval_state` (D9) — proven structurally, not by convention.
- `_apply_precedence` demotes losers, it never drops them — the audit trail must survive
  arbitration (spec: Precedence Conflict Arbitration).
- No finding without literal `evidence_text` grounding (carried invariant from
  `precise-thesis-review-pipeline`).
- `SOURCE_PRECEDENCE` in `base.py` must mirror `0006`'s generated `precedence` expression
  exactly — the migration is the source of truth.
- No APA 7 content, anywhere — no supplied source document mentions it.

## Work Units

### 1. Migration `0006_normative_governance.sql`

- [x] RED: Integration test (real Postgres) asserting `normative_source.precedence` resolves
      1/2/3 for `reglamento_tesis`/`apa_6`/`gt_guide`; the `lineamientos_ingenieria_sistemas.txt`
      row has `source_type = 'reglamento_tesis'`; an `apa_6` row exists; `finding_type = 'structure'`
      is accepted. Before the migration, each assertion fails for a distinct real reason: the
      `precedence` column does not exist (`column "precedence" does not exist`), the corpus row
      is still typed `'rubric'`, zero `apa_6` rows exist, and the `finding_type` CHECK rejects
      `'structure'` (constraint violation).
- [x] GREEN: Write `0006_normative_governance.sql` UP exactly per D1 (`GENERATED ALWAYS AS
      (CASE source_type ...) STORED`, retype UPDATE, idempotent `apa_6` INSERT via `WHERE NOT
      EXISTS`, widened `finding_type` CHECK, `idx_normative_source_precedence`).
- [x] TRIANGULATE: Running the seed INSERT twice leaves exactly one `apa_6` row (idempotency);
      an explicit `INSERT ... (precedence) VALUES (...)` against the generated column is
      rejected by Postgres itself, structurally satisfying the spec's "insert without precedence
      is rejected" scenario without any application-level check.
- [x] REFACTOR: N/A — DDL only.
- [x] Verify: `pnpm --dir apps/api test` green; `migrate.mjs up` then `migrate.mjs down` cycles
      cleanly against dockerized pg.
- [x] Rollback: DOWN retypes `reglamento_tesis` → `rubric` and deletes the seeded `apa_6` row
      **before** narrowing the CHECKs back, per the documented statement order; `migrate.mjs
      down` for `0006`.

### 2. `RuleFinding.normative_source_type` + `SOURCE_PRECEDENCE` + `squeeze()`

- [x] RED: `services/worker/tests/test_rules.py` (or a new `test_base.py`) asserts
      `RuleFinding(normative_source_type=None)` is a valid default construction,
      `SOURCE_PRECEDENCE == {"reglamento_tesis": 1, "apa_6": 2, "gt_guide": 3}`, and
      `squeeze("numeraci ón")` equals `squeeze("numeración")`. Before implementation this fails
      with `TypeError: __init__() got an unexpected keyword argument 'normative_source_type'`
      and `ImportError: cannot import name 'squeeze'` — the field and helper genuinely do not
      exist yet.
- [x] GREEN: Add the frozen-dataclass field (appended after existing defaults, so no call site
      breaks), the `SOURCE_PRECEDENCE` dict, and `squeeze()` (fold + strip all whitespace) to
      `base.py`.
- [x] TRIANGULATE: `squeeze()` on text with an internal line-wrap *and* an intra-word split
      (`"m ismas"`) still matches its clean form; `RuleFinding` stays frozen — mutation still
      requires `dataclasses.replace()`.
- [x] REFACTOR: `squeeze()` calls the existing `fold()` rather than duplicating its
      case/accent-normalization logic.
- [x] Verify: `pnpm --dir services/worker test` green.
- [x] Rollback: revert the 3 additions to `base.py`; no caller depends on them yet (this unit is
      additive-only).

### 3. `run_rules()` stamping + re-tag existing modules

- [x] RED: `test_rules.py` asserts a `filler_words` finding produced by `run_rules()` carries
      `normative_source_type == "gt_guide"` and `metadata["precedence_tier"] == 3`. Before
      implementation this fails because nothing stamps the field (`None`, today's real
      behavior) and `filler_words.py`/`long_sentences.py`/`spelling.py`/`gt_structure.py` have
      no `NORMATIVE_SOURCE_TYPE` constant. A second case registers a throwaway fixture module
      lacking the constant and asserts `run_rules()` raises `AttributeError` — before
      implementation there is no stamping loop to raise at all, so the test itself cannot yet
      observe the loud-failure behavior it is meant to lock in.
- [x] GREEN: Implement the stamping loop in `run_rules()` per D3 (`getattr` on
      `NORMATIVE_SOURCE_TYPE`, `SOURCE_PRECEDENCE[source_type]`, `dataclasses.replace()`); add
      `NORMATIVE_SOURCE_TYPE = "gt_guide"` (one line) to `gt_structure.py`, `filler_words.py`,
      `long_sentences.py`, `spelling.py`.
- [x] TRIANGULATE: a module declaring an unrecognized `NORMATIVE_SOURCE_TYPE` string not present
      in `SOURCE_PRECEDENCE` raises `KeyError`, not a silent `None`/default tier.
- [x] REFACTOR: keep the stamping loop adjacent to the existing `MIN_RULE_CONFIDENCE` filter for
      readability.
- [x] Verify: `pnpm --dir services/worker test` green; a structural test enumerates
      `_RULE_MODULES` and asserts every one declares `NORMATIVE_SOURCE_TYPE`.
- [x] Rollback: revert the stamping loop and the 4 one-line constants; findings regress to
      `normative_source_type=None` — matches the pre-change state, no data loss (column stays
      nullable).

**Deviation found during apply**: `run_rules()`'s stamping loop reads `NORMATIVE_SOURCE_TYPE` via
unconditional `getattr()` on EVERY module in `_RULE_MODULES` (5 modules today, not 4) —
`citations.py` is already registered and was NOT in this unit's "re-tag 4 existing modules" list.
Omitting it would raise `AttributeError` on every `run_rules()` call once GREEN landed, breaking
the pre-existing citation cross-check and the whole `/internal/rules` endpoint. Added the
one-line `NORMATIVE_SOURCE_TYPE = "apa_6"` constant to `citations.py` as well (PR1), consistent
with design.md D3's own module table (which lists citations.py's tier unconditionally, not gated
behind D6's PR2 rule additions). No D6 rule logic (et-al./quote-length checks) was added — that
stays PR2 scope.

### 4. `getNormativeSourceIdsBySourceType()` + widened `resolveNormativeSourceId`

- [x] RED: `apps/api/tests/review-repository.test.mjs` case against dockerized pg —
      `getNormativeSourceIdsBySourceType()` returns one id per `source_type`, picking the
      lowest-`precedence`/lowest-`id` row when a type has multiple corpus rows (`gt_guide` has
      two). Before implementation: `TypeError: repository.getNormativeSourceIdsBySourceType is
      not a function`. A second case in the pipeline's resolver test calls
      `resolveNormativeSourceId(repository, "apa_6")` and asserts a real numeric id — today it
      returns `null` because the cache is keyed only by `*.txt` filenames.
- [x] GREEN: Implement `getNormativeSourceIdsBySourceType()` (`SELECT DISTINCT ON (source_type)
      ... ORDER BY source_type, precedence, id`) in `review-repository.mjs`; widen
      `resolveNormativeSourceId`'s cache merge in `live-review-pipeline.mjs` per D4; update
      `DEFAULT_SOURCE_TYPE_BY_FILE`'s `lineamientos_ingenieria_sistemas.txt` entry to
      `reglamento_tesis`.
- [x] TRIANGULATE: a filename key (`"lineamientos_ingenieria_sistemas.txt"`) and a source_type
      key (`"apa_6"`) coexist in the same merged cache in one test run without collision, both
      resolving correctly.
- [x] REFACTOR: N/A — additive cache merge only.
- [x] Verify: `pnpm --dir apps/api test` green against dockerized pg.
- [x] Rollback: revert both files; `resolveNormativeSourceId("apa_6")` returns `null` again, CAG
      filename-keyed path is byte-identical and unaffected.

### 5. Orchestrator wiring fix (`review-orchestrator.mjs:239`)

- [x] RED: `apps/api/tests/review-orchestrator.test.mjs` case — after a rules-persistence run,
      `persistFinding` is called with `normativeSourceId` equal to the real resolved id for the
      finding's `normative_source_type`. Before this fix, the hardcoded `normativeSourceId:
      null` at line 239 makes the assertion fail with the real resolved id expected but `null`
      observed.
- [x] GREEN: Replace the hardcoded `null` with `await resolveNormativeSourceId(ruleFinding
      .normative_source_type)`.
- [x] TRIANGULATE: a finding whose `normative_source_type` resolves to no row (defensive case —
      unseeded DB) still persists with `normativeSourceId: null` rather than throwing; the run
      completes, status is not corrupted.
- [x] REFACTOR: N/A — one-line call-site change.
- [x] Verify: `pnpm --dir apps/api test && pnpm --dir services/worker test` green; a manual
      end-to-end run confirms non-null `normative_source_id` on `finding` rows produced by the
      rules path.
- [x] Rollback: revert the one-line diff; `normativeSourceId` returns to `null` (safe — column
      is nullable, existing rows already hold `null`).

### 6. Approval-gate isolation proofs (D9)

- [x] RED: (a) A migration-text-scan test first asserts it correctly *fails* against a fixture
      string deliberately containing `review_workflow_item`, proving the scanner itself
      detects a violation, before asserting it passes clean against the real
      `0006_normative_governance.sql` text. (b) A `review-orchestrator.test.mjs` case wraps the
      repository in a proxy that throws on any method name matching `/workflow|approval|
      approve/i`; a decoy call to a stubbed `approveWorkflowItem()` is temporarily inserted into
      a throwaway copy of the rules-persistence path to prove the trap fires (test fails with
      the expected "blocked workflow call" error) before the decoy is removed.
- [x] GREEN: Remove the decoy call — the real rules-persistence path never calls anything
      matching the trap to begin with. Both tests now run against the real migration file and
      real orchestrator code, both green.
- [x] TRIANGULATE: the proxy trap also fires for case-insensitive variants
      (`getApprovalState`, `updateWorkflowApprovalState`), not only an exact-name match.
- [x] REFACTOR: N/A — assertion-only tests.
- [x] Verify: `pnpm --dir apps/api test` green, including both D9 proofs.
- [x] Rollback: N/A — test-only unit; removal only drops the regression guard, no production
      behavior changes.

### 7. `reglamento_structure.py` (new module, D5)

- [ ] RED: `services/worker/tests/test_reglamento_structure.py` — correct 6-element preliminary
      sequence in order produces no finding; a missing "autoridades y tribunal" page produces
      `missing_preliminary_page`; an out-of-order sequence produces
      `preliminary_page_out_of_order`; exact Artículo 8° text produces no finding; a
      `difflib.SequenceMatcher` ratio ≥0.85 near-match produces `articulo_8_altered`; a ratio
      <0.85 across every page produces `articulo_8_missing`; empty `pages` or fewer than
      `PRELIMINARY_SCAN_PAGES` pages with no text returns `[]`. Before implementation:
      `ModuleNotFoundError: services.worker.app.rules.reglamento_structure`.
- [ ] GREEN: Implement `reglamento_structure.py` per D5 (`PRELIMINARY_SCAN_PAGES=8`,
      `REQUIRED_ARTICLE_8_TEXT`, `PRELIMINARY_SEQUENCE`, `squeeze()`-based phrase matching,
      the 0.85 altered/missing split); register the module in `__init__.py`'s `_RULE_MODULES`.
- [ ] TRIANGULATE: intra-word-split PDF text (`"numeraci ón"`, `"m ismas"`, `"marg en"`) still
      matches via `squeeze()`; a ratio of exactly 0.849 classifies `missing`, 0.85 classifies
      `altered` (boundary case is exercised explicitly, not left implicit).
- [ ] REFACTOR: extract the shared squeeze-based phrase-matching helper if the
      missing/out-of-order/altered checks start duplicating it.
- [ ] Verify: `pnpm --dir services/worker test` green.
- [ ] Rollback: delete `reglamento_structure.py` and its `_RULE_MODULES` registration together
      (one revertable unit — the module has no other caller).

### 8. `citations.py` APA-6 additions (D6)

- [ ] RED: `test_citations.py` additions — a 2-author citation repeated across mentions
      produces no et-al. finding; a 4-author citation fully named on first mention and
      abbreviated on the second produces no finding; a 7-author citation fully named on its
      first mention produces `et_al_required_six_authors`; an `"X et al."` citation whose
      reference entry names exactly 2 authors produces `et_al_on_two_author_source`; a 25-word
      inline quoted span produces no finding; a 55-word inline (non-block) quoted span produces
      `long_quote_not_block`. Before implementation none of these `rule_id`s exist —
      each assertion fails with "expected a finding, found none."
- [ ] GREEN: Implement the 4 checks from D6's table as a second, independent scanner over the
      same extracted text (the existing citation-vs-reference cross-check is untouched); add
      `NORMATIVE_SOURCE_TYPE = "apa_6"`; bounded author-group/quote-span regex with
      `MAX_QUOTE_SPAN_CHARS = 2000` as the ReDoS guard.
- [ ] TRIANGULATE: an unterminated quotation mark spanning past `MAX_QUOTE_SPAN_CHARS` does not
      hang and does not swallow the rest of the page; the pre-existing citation-vs-reference
      cross-check test cases remain green, unmodified by the new scanner.
- [ ] REFACTOR: factor the shared author-list-parsing regex between the three et-al. checks if
      it is duplicated three times.
- [ ] Verify: `pnpm --dir services/worker test` green, including the untouched pre-existing
      `citations.py` test cases (regression check).
- [ ] Rollback: revert only the D6 additions; the pre-existing cross-check function and its
      tests are untouched and keep working.

### 9. `_apply_precedence()` + limitation-guard test (D7)

- [ ] RED: (a) A constructed-fixture test — two `RuleFinding` objects share
      `metadata={"conflict_key": "art8-text"}`, one stamped tier 1 (`reglamento_tesis`), one
      tier 3 (`gt_guide`). Before `_apply_precedence()` exists, both findings pass through
      unmodified, so asserting the tier-3 finding's metadata contains
      `superseded_by_higher_precedence` fails with `KeyError`. (b) A limitation-guard test
      asserts that **zero** of the currently-registered `_RULE_MODULES` ever emit a finding with
      a `conflict_key` across a representative fixture run — this documents, in executable
      form, that no real production conflict exists to arbitrate today, and will fail loudly
      the day a real one is introduced without review.
- [ ] GREEN: Implement `_apply_precedence(findings)` per D7 — group by `conflict_key`, keep the
      lowest `precedence_tier` active, demote losers to `severity="low"` plus
      `metadata["superseded_by_higher_precedence"] = {winning_source_type, winning_tier,
      winning_rule_id}`, tie-break by module registration order; wire it as `run_rules()`'s
      final step.
- [ ] TRIANGULATE: findings without a `conflict_key` metadata key pass through completely
      unmodified (spec: "Findings without a shared conflict_key are unaffected"); a
      constructed 3-way same-tier tie resolves deterministically by registration order, not
      arbitrarily.
- [ ] REFACTOR: N/A — pure function over a list, already minimal per the design's honest-TDD
      note; no synthetic production rule was added to manufacture a fake conflict.
- [ ] Verify: `pnpm --dir services/worker test` green, including both the demotion fixture and
      the limitation-guard test.
- [ ] Rollback: revert `_apply_precedence()` and its call from `run_rules()`; since no real
      module currently emits `conflict_key`, no production finding's shape changes.

### 10. D8 non-goals structural enforcement

- [ ] RED: A new scanner test walks every registered module's `rule_id` string constants,
      case/accent-folds them, and checks for the tokens
      `margen|interlineado|fuente|sangria|cursiva|paginacion`. It first asserts the scanner
      correctly *fails* against a fixture `rule_id` containing `"margen_incorrecto"`, proving
      the scanner isn't a no-op, then asserts it passes clean against every real registered
      module's `rule_id`s.
- [ ] GREEN: Add the `NOT_COVERED` module-level prose constant to `reglamento_structure.py` per
      D8; land the scanning test as a permanent structural guard alongside the module-registry
      introspection tests.
- [ ] TRIANGULATE: the scanner also catches an accent-bearing variant (`"márgen"` folds to
      `"margen"`) and a token embedded mid-string, not only an exact `rule_id` match.
- [ ] REFACTOR: N/A — assertion-only guard.
- [ ] Verify: `pnpm --dir services/worker test` green, including the fixture self-test that
      proves the scanner is not a no-op.
- [ ] Rollback: N/A — test-only guard; removal only drops the future-regression tripwire, no
      production behavior changes.

## Suggested PR Chain

1. **PR1 — Governance spine** (Work Units 1-6): `0006_normative_governance.sql`,
   `base.py`'s `normative_source_type`/`SOURCE_PRECEDENCE`/`squeeze()`, `run_rules()` stamping
   + the 4 existing-module re-tags, `getNormativeSourceIdsBySourceType()` + widened
   `resolveNormativeSourceId`, the `review-orchestrator.mjs:239` fix, and the D9 approval-gate
   proofs. Alone satisfies "zero deterministic rule findings persist with a null
   `normative_source_id`."
2. **PR2 — Grounded rules** (Work Units 7-10), based on PR1: `reglamento_structure.py`,
   `citations.py`'s APA-6 additions, `_apply_precedence()` with its limitation-guard test, and
   the D8 non-goals structural scanner.
