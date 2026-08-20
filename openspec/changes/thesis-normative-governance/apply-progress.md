# Apply Progress: thesis-normative-governance

**Scope**: PR1 "governance spine" only (Work Units 1-6 of `tasks.md`). PR2
"grounded rules" (Work Units 7-10: `reglamento_structure.py`, `citations.py`
APA-6 additions, `_apply_precedence()`, D8 structural guard) is **not**
implemented — those checkboxes remain unchecked for a future apply pass.

**Mode**: Strict TDD (every unit below followed RED -> GREEN -> TRIANGULATE ->
REFACTOR -> Verify -> Rollback).

## Status

6/6 PR1 work units complete. 24/60 total tasks.md checkboxes remain
unchecked (all PR2, Work Units 7-10, deliberately out of scope for this
pass).

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
