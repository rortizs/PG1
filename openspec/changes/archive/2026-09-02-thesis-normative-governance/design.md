# Design: Thesis Normative Governance Harness

> Size note: this design exceeds the 800-word budget, following the house exception set by
> `precise-thesis-review-pipeline/design.md`. The change spans a schema migration, a
> cross-language field contract, and two new grounded rule families; exact SQL, constants and
> verbatim normative text are the artifact's value. Prose is minimized to tables and code.

## Technical Approach

Provenance becomes a **declared, schema-enforced property** rather than a per-call-site
decision. Each Python rule module declares which normative document authorizes it;
`run_rules()` stamps that declaration onto every finding it emits; Node resolves the
declaration to a real `normative_source.id` through the **one already-existing resolver**.
Precedence is derived from `source_type` inside the schema itself, so the tier ordering cannot
drift from the source registry.

```
rule module (NORMATIVE_SOURCE_TYPE)
        │
   run_rules() ── stamps normative_source_type + metadata.precedence_tier
        │      └─ _apply_precedence(): conflict_key grouping → demotion
        │
  /internal/rules → asdict() → JSON  (main.py UNCHANGED)
        │
review-orchestrator.mjs ── resolveNormativeSourceId(source_type) ──┐
        │                                                          │
        └──────────── persistFinding({ normativeSourceId }) ──► finding.normative_source_id
```

## Architecture Decisions

### D1 — Migration `0006_normative_governance.sql`

Two grounding facts drove this, both verified by reading the repo:

1. **The Reglamento is already in the corpus, mis-typed.**
   `data/academic-rules/lineamientos_ingenieria_sistemas.txt` is not a rubric — it contains
   `REGLAMENTO DE TESIS`, `Artículo 8°: RESPONSABILIDAD` (L149-155) and Artículos 30-37/50
   (L255-311) verbatim. `DEFAULT_SOURCE_TYPE_BY_FILE` types it `'rubric'`
   (`review-repository.mjs:14`). The migration **retypes the existing row**; it does not invent one.
2. **`apa_6` has no row at all.** No APA file exists in `data/academic-rules/`, and
   `seedNormativeSources()` only ever inserts corpus `.txt` files — so `apa_6` is a legal
   `CHECK` value that nothing ever writes. Without seeding it, wiring `citations.py` would
   still resolve to `null`. The migration seeds a metadata-only `apa_6` row.

```sql
-- UP
ALTER TABLE normative_source DROP CONSTRAINT normative_source_source_type_check;
ALTER TABLE normative_source ADD CONSTRAINT normative_source_source_type_check
  CHECK (source_type IN ('gt_guide','apa_6','rubric','example_observation','reglamento_tesis'));

ALTER TABLE normative_source ADD COLUMN precedence INTEGER NOT NULL
  GENERATED ALWAYS AS (CASE source_type
    WHEN 'reglamento_tesis' THEN 1 WHEN 'apa_6' THEN 2 WHEN 'gt_guide' THEN 3 ELSE 99 END) STORED;

UPDATE normative_source SET source_type = 'reglamento_tesis'
  WHERE title = 'lineamientos_ingenieria_sistemas.txt';

INSERT INTO normative_source (source_type, title, version_label, is_approved, metadata)
SELECT 'apa_6', 'Manual de Normas APA (6a edición)', '6a edición', true,
       '{"seeded_by":"0006_normative_governance","corpus_file":null}'
WHERE NOT EXISTS (SELECT 1 FROM normative_source WHERE source_type = 'apa_6');

ALTER TABLE finding DROP CONSTRAINT finding_finding_type_check;
ALTER TABLE finding ADD CONSTRAINT finding_finding_type_check
  CHECK (finding_type IN ('gt','apa','writing_style','grammar','congruence','methodology',
                          'rag_review','structure'));

CREATE INDEX idx_normative_source_precedence ON normative_source(precedence);
-- DOWN: reverse order; retype 'reglamento_tesis'→'rubric' and delete the seeded apa_6 row
-- BEFORE restoring the narrower CHECKs, else the CHECK re-add fails.
```

| Option | Tradeoff | Decision |
|---|---|---|
| `precedence` as a plain `INTEGER DEFAULT` | Every future insert path (`seedNormativeSources`, admin CRUD) must remember to set it; silently wrong on a fresh DB | Rejected |
| **`GENERATED ALWAYS AS (CASE source_type …) STORED`** | Tier changes need a migration | **Chosen** — desync between source and tier becomes structurally impossible, and a governance tier *should* require a migration. `seedNormativeSources()` needs no change at all |
| Separate `normative_precedence` lookup table | Correct 3NF, but a 3-row table joined on every finding read | Rejected — disproportionate |

`source_type` value is **`'reglamento_tesis'`**, taken from the document's own title
(`REGLAMENTO DE TESIS`, corpus L149), not `'reglamento_biblioteca'` — the document is the
university's thesis regulation, and the library is only its custodian.

### D2 — `finding_type`: extend with `'structure'`, do not reuse `'gt'`

| Option | Tradeoff | Decision |
|---|---|---|
| Reuse `'gt'` | Zero migration, but asserts the GT guide requires preliminary pages — it does not; the Reglamento does. A false provenance claim in the very change that exists to fix provenance | Rejected |
| Add `'reglamento'` | Re-encodes provenance in the type column, duplicating `normative_source_id` | Rejected — two columns holding the same fact |
| **Add `'structure'`** | One CHECK migration | **Chosen** — source-neutral *semantic* category. Provenance lives in `normative_source_id`, severity in `severity`, category in `finding_type`; each column means exactly one thing |

Blast radius verified: `finding_type` has **zero** consumers in `apps/web/src`; the only
readers are `listFindingsForReviewRun` (passthrough) and the `idx_finding_review_run_finding_type`
index. Adding a value breaks nothing.

### D3 — `RuleFinding` carries the declaration; `run_rules()` stamps it

`base.py` gains one defaulted field (safe: appended after existing defaults) plus the tier table:

```python
SOURCE_PRECEDENCE = {"reglamento_tesis": 1, "apa_6": 2, "gt_guide": 3}
# INVARIANT: mirrors 0006_normative_governance.sql's generated `precedence` expression.
# The migration is the source of truth; this table exists because `app/rules/` has no DB access.

@dataclass(frozen=True)
class RuleFinding:
    ...
    normative_source_type: str | None = None
```

Each module declares `NORMATIVE_SOURCE_TYPE` at module level, mirroring the existing
`MIN_RULE_CONFIDENCE` / `CONFIDENCE` / `RULE_ID` module-constant convention:

| Module | `NORMATIVE_SOURCE_TYPE` | Tier |
|---|---|---|
| `reglamento_structure.py` (new) | `reglamento_tesis` | 1 |
| `citations.py` | `apa_6` | 2 |
| `gt_structure.py`, `filler_words.py`, `long_sentences.py`, `spelling.py` | `gt_guide` | 3 |

**Who sets the field**: `run_rules()`, not each module. Modules declare; the engine stamps via
`dataclasses.replace()` (the dataclass is frozen). Rejected alternative — each module passing
`normative_source_type=` into every `RuleFinding(...)` call — because it is silently
forgettable, and a module that forgot it would regress to today's `null` provenance with no
signal. A single choke point makes omission impossible; `getattr` on a module missing the
constant raises loudly at the first run.

```python
def run_rules(pages, sections=None):
    ...
    for module in _RULE_MODULES:
        source_type = module.NORMATIVE_SOURCE_TYPE          # AttributeError = loud, not silent
        tier = SOURCE_PRECEDENCE[source_type]               # KeyError = loud, not silent
        for finding in module.check(pages, sections):
            if finding.confidence < MIN_RULE_CONFIDENCE:
                continue
            findings.append(replace(finding,
                normative_source_type=source_type,
                metadata={**finding.metadata, "precedence_tier": tier}))
    return _apply_precedence(findings)
```

`main.py` needs **no change**: `/internal/rules` already returns `asdict(finding)`
(`main.py:139`), so the new field crosses the HTTP boundary automatically.

### D4 — Node resolution: extend the existing resolver's key space, do not fork it

The instruction was to reuse `resolveNormativeSourceId`. Reading it revealed a real constraint
that must be stated: it resolves by **corpus filename**, not by source type —
`live-review-pipeline.mjs:134-139` caches `repository.seedNormativeSources()`, whose returned
map is `idByFile` keyed by `*.txt` (`review-repository.mjs:191-211`). Passing `"apa_6"` to it
today returns `null`.

So the resolver is reused and its key space is widened, rather than a parallel resolver being
invented:

```js
// live-review-pipeline.mjs — same function, same signature, same single cache
async function resolveNormativeSourceId(repository, ref) {
  if (!cachedNormativeSourceIds) {
    cachedNormativeSourceIds = {
      ...(await repository.seedNormativeSources()),          // "*.txt" keys (CAG path, unchanged)
      ...(await repository.getNormativeSourceIdsBySourceType()), // source_type keys (rules path)
    };
  }
  return cachedNormativeSourceIds[ref] ?? null;
}
```

Key collision is impossible: filename keys always end in `.txt`, `source_type` values never do.
The CAG path's behavior is byte-identical.

New repository method — deterministic when a type has several rows (`gt_guide` has two corpus
files):

```js
async getNormativeSourceIdsBySourceType() // SELECT DISTINCT ON (source_type) source_type, id
                                          // FROM normative_source ORDER BY source_type, precedence, id
                                          // -> { reglamento_tesis: 7, apa_6: 9, gt_guide: 1, ... }
```

`review-orchestrator.mjs:239` then becomes:

```js
normativeSourceId: await resolveNormativeSourceId(ruleFinding.normative_source_type),
```

`persistFinding` is unchanged — it already accepts `normativeSourceId`
(`review-repository.mjs:687-758`). `DEFAULT_SOURCE_TYPE_BY_FILE` changes one entry
(`lineamientos_ingenieria_sistemas.txt` → `reglamento_tesis`) so a fresh DB seeds the corrected
type without the migration's `UPDATE`.

### D5 — `reglamento_structure.py` (new, tier 1)

**Input**: `pages` only. Deliberately **not** `sections` — heading detection
(`extraction.py`'s `HEADING_PATTERN_TABLE`) targets body chapters, and preliminary pages carry
no reliable heading shape. `page_number` is the physical PDF index; the roman numerals
(`III`, `IV` — corpus L102, L139) appear only as page *text*, never as `page_number`. The
module scans page text in document order.

**Normalization**: `fold()` handles case/accents/line-wraps, but extracted PDF text contains
intra-word spurious spaces (`numeraci ón`, `m ismas`, `marg en` — corpus L220, L276, L310). A
new `squeeze(text)` helper in `base.py` folds *and removes all whitespace*, making phrase
matching immune to both wraps and intra-word splits. This is the false-positive defense.

| Check | `rule_id` | Grounding | conf | severity |
|---|---|---|---|---|
| Preliminary element missing | `reglamento_structure.missing_preliminary_page` | Art. 30-37 + models, corpus L3-L149 | 0.75 | medium |
| Preliminary elements out of order | `reglamento_structure.preliminary_page_out_of_order` | same | 0.75 | low |
| Artículo 8° absent | `reglamento_structure.articulo_8_missing` | corpus L151-155 | 0.90 | high |
| Artículo 8° present but altered | `reglamento_structure.articulo_8_altered` | same | 0.90 | high |

```python
PRELIMINARY_SCAN_PAGES = 8   # models occupy 6 pages; +2 tolerance for guardas (Art. 32)
REQUIRED_ARTICLE_8_TEXT = (
    "Solamente el autor es responsable de los conceptos expresados en el trabajo de tesis. "
    "Su aprobación en manera alguna implica responsabilidad para la Universidad."
)
PRELIMINARY_SEQUENCE = (   # (label, alternative marker phrases — any one matches)
    ("carátula exterior",            ("universidad mariano galvez de guatemala",)),
    ("carátula interior",            ("previo a optar al grado academico",)),
    ("autoridades y tribunal",       ("autoridades de la facultad", "decano de la facultad")),
    ("autorización de impresión",    ("orden de impresion",)),
    ("artículo 8 (responsabilidad)", ("articulo 8", "reglamento de tesis")),
    ("índice",                       ("indice",)),
)
```

Artículo 8° matching: `squeeze(REQUIRED_ARTICLE_8_TEXT) in squeeze(page_text)` → satisfied.
Otherwise `difflib.SequenceMatcher` (stdlib only — `base.py` is deliberately dependency-free)
over squeezed forms; `ratio() >= 0.85` on any page ⇒ **altered** (evidence = that page's literal
near-match span); below that on every page ⇒ **missing**.

**Zero-evidence skip**, mirroring `gt_structure.py`'s existing invariant: empty `pages`, or
fewer than `PRELIMINARY_SCAN_PAGES` pages with no text at all, returns `[]` — no evidence, no
finding, never fabricated. Every finding's `evidence_text` is literal extracted text (for a
*missing* element, the literal text of the preliminary block that was actually found).

### D6 — `citations.py` APA-6 additions (tier 2)

The existing cross-check (`_IN_TEXT_CITATION_PATTERN` / `_REFERENCE_ENTRY_PATTERN`, both green
today) is **kept intact**. The et-al. rules run as a *second, independent scanner* over the same
text. Restructuring the existing first-author+year keying would risk regressing passing tests
for zero benefit; two cheap regex passes are the right trade.

| `rule_id` | Rule | Checkable from text? | conf | sev |
|---|---|---|---|---|
| `citations.et_al_required_six_authors` | 6+ named authors in one in-text group ⇒ `et al.` from the 1st mention | **Yes**, fully | 0.85 | medium |
| `citations.et_al_required_after_first_mention` | 3-5 named authors listed in full on a 2nd+ occurrence of the same (first-author, year) key | **Yes**, by occurrence order | 0.80 | medium |
| `citations.et_al_on_two_author_source` | `X et al.` whose reference entry names exactly 2 authors | Yes, **only when** the reference entry resolves | 0.75 | low |
| `citations.long_quote_not_block` | Quoted span of ≥ 40 words | **Yes** | 0.80 | medium |

**Deliberately not implemented, with reasons stated in the module docstring**: a 1-2 author
citation that *should* have listed both cannot be detected from an `et al.` alone (the hidden
count is unknowable) — rule 3 covers only the reference-resolvable half; and a block quote
under 40 words cannot be detected, because "block" is an indentation property and
`extraction.py` is text-only.

**ReDoS guard** (untrusted thesis text): the author-group and quoted-span patterns use bounded
character classes with no nested quantifiers, and the quote scanner rejects any span longer
than `MAX_QUOTE_SPAN_CHARS = 2000` — an unmatched quotation mark can therefore never swallow a
page.

### D7 — Precedence harness Part 2: `_apply_precedence()`

```python
def _apply_precedence(findings: list[RuleFinding]) -> list[RuleFinding]:
    """Findings without metadata['conflict_key'] pass through untouched."""
```

Within a `conflict_key` group the lowest `precedence_tier` wins. Losers are **demoted, never
dropped** — severity lowered to `"low"` and stamped with
`metadata["superseded_by_higher_precedence"] = {"winning_source_type", "winning_tier",
"winning_rule_id"}`. Dropping would destroy the audit trail this change exists to create.
Ties inside one tier resolve by first-emitted order (module registration order), which is
deterministic.

**Honest TDD strategy for an untestable-in-production path** (the explore flagged this):
`_apply_precedence` is a pure function over a list, so it is triangulated directly with
constructed `RuleFinding` fixtures — a tier-1 and a tier-3 finding sharing a `conflict_key` —
with no fake module and no synthetic production rule. RED/GREEN/TRIANGULATE is fully preserved.
Paired with it, a **limitation-guard test** asserts that **zero** currently-registered module
emits a `conflict_key`. It documents the gap in executable form and fails loudly the day a real
conflict is introduced, forcing a deliberate review instead of a silent behavior change.

### D8 — Non-goals made structural, not just documented

`reglamento_structure.py` carries a module-level constant, not only prose:

```python
NOT_COVERED = (   # Blocked on layout-aware extraction; `extraction.py` is pypdf text-only.
    "márgenes (Art. 30/31)", "interlineado", "tipografía y tamaño de fuente",
    "posición de la paginación (Art. 37/50)", "sangría francesa", "cursivas",
    "fidelidad visual de portada/contraportada (escudo 11cm, cartulina) — permanentemente "
    "fuera de alcance automatizable, corresponde a la revisión física de biblioteca",
)
```

Enforced by a test that scans every registered module's `rule_id` constants for the tokens
`margen|interlineado|fuente|sangria|cursiva|paginacion` and fails if any appears — so a future
rule cannot quietly claim layout coverage the extraction pipeline cannot support.

### D9 — Approval-gate isolation, proven structurally

`review_workflow_item` is not in a separate module — it lives inside `review-repository.mjs`
alongside `persistFinding`, so "zero imports of a workflow repository" is **not** an available
proof. The two real, enforceable proofs:

1. **Migration proof**: `0006_normative_governance.sql` names only `normative_source` and
   `finding`. A test asserts the migration file text contains neither `review_workflow_item`
   nor `approval_state`.
2. **Call-path proof**: the orchestrator test wraps the repository in a proxy that throws on
   any method name matching `/workflow|approval|approve/i`. A full rules-persistence run must
   complete without tripping it.

Invariant: this change writes `finding` and reads `normative_source`. Nothing else.

## File Changes

| File | Action | Description |
|---|---|---|
| `apps/api/src/db/migrations/0006_normative_governance.sql` | Create | D1 |
| `apps/api/src/db/review-repository.mjs` | Modify | `getNormativeSourceIdsBySourceType()`; retype `lineamientos_ingenieria_sistemas.txt` in `DEFAULT_SOURCE_TYPE_BY_FILE` |
| `apps/api/src/live-review-pipeline.mjs` | Modify | widen `resolveNormativeSourceId`'s cached key space (D4) |
| `apps/api/src/jobs/review-orchestrator.mjs` | Modify | replace hardcoded `normativeSourceId: null` (line 239) |
| `services/worker/app/rules/base.py` | Modify | `normative_source_type` field, `SOURCE_PRECEDENCE`, `squeeze()` |
| `services/worker/app/rules/__init__.py` | Modify | register module, stamp declarations, `_apply_precedence()` |
| `services/worker/app/rules/reglamento_structure.py` | Create | D5 |
| `services/worker/app/rules/citations.py` | Modify | D6 additions + `NORMATIVE_SOURCE_TYPE` |
| `services/worker/app/rules/{gt_structure,filler_words,long_sentences,spelling}.py` | Modify | declare `NORMATIVE_SOURCE_TYPE` (one line each) |
| `services/worker/app/main.py` | **Unchanged** | `asdict()` already forwards the new field |

## Testing Strategy (strict TDD — every row is a RED test first)

| Layer | What to test | Approach |
|---|---|---|
| Unit (py) | `squeeze()` vs intra-word split text; each preliminary element missing/out-of-order; Art. 8 exact / altered / missing; each APA-6 et-al. threshold; ≥40-word quote; `_apply_precedence` demotion + tie-break | `unittest` with literal corpus-derived fixtures |
| Unit (py, structural) | every registered module declares `NORMATIVE_SOURCE_TYPE`; every tier resolves in `SOURCE_PRECEDENCE`; no `rule_id` contains a layout token (D8); zero module emits `conflict_key` (D7 limitation guard) | module-registry introspection, mirroring the existing `ImportBoundaryTest` |
| Unit (js) | `getNormativeSourceIdsBySourceType` picks lowest precedence/id per type; resolver returns ids for both filename and source_type keys | `node:test` + real Postgres (existing pattern) |
| Integration | migration UP/DOWN; retyped Reglamento row has `precedence = 1`; seeded `apa_6` row is idempotent across two runs; a `'structure'` finding inserts | real Postgres |
| Integration | **zero** persisted rule findings have `normative_source_id IS NULL`; approval-gate proxy proof (D9) | fake worker + real Postgres |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. The one adversarial-input surface (regex over untrusted thesis
text) is addressed inline in D6 by bounded patterns and `MAX_QUOTE_SPAN_CHARS`.

## Migration / Rollout

One forward migration (`0006`) with a working DOWN whose statement order is
retype-and-delete **before** narrowing the CHECKs. Existing `finding` rows are unaffected:
`normative_source_id` is nullable and already `null` everywhere.

**Size forecast for `sdd-tasks`**: the proposal assumed a single PR (explore rated effort
Medium). Reading the real code raises that estimate — roughly 350-450 authored production lines
plus a comparable test volume, which is likely to exceed the 400-line review budget. Two
slices, each independently valuable and revertable, are recommended: **(1) governance spine** —
migration, `RuleFinding` field, `run_rules()` stamping, resolver widening, orchestrator wiring
fix, existing modules re-tagged (this alone satisfies "zero findings with a null source");
**(2) grounded rules** — `reglamento_structure.py`, the APA-6 citation rules, and
`_apply_precedence`. Final guard lines are `sdd-tasks`' call.

## Deviations from the Proposal

| Proposal assumed | Design found | Consequence |
|---|---|---|
| A new Reglamento source must be created | The Reglamento already exists in the corpus, typed `'rubric'` | Migration **retypes**; `DEFAULT_SOURCE_TYPE_BY_FILE` corrected |
| `apa_6` sources exist | Legal CHECK value, **zero rows**, no corpus file | Migration must **seed** an `apa_6` row or citation wiring still yields `null` |
| `resolveNormativeSourceId` can be reused as-is | It resolves by corpus **filename**, not source type | Same function reused, key space widened (D4) — not forked |
| `finding_type` CHECK: extend or reuse `'gt'` (left open) | Provenance now has its own column | Extended with `'structure'`; `'reglamento'` rejected as duplicate provenance encoding |
| `citations.py` gains reference-entry-shape checks | Distinguishing features (hanging indent, italics) are layout | Reference-shape **dropped**; the existing cross-check already covers the text-checkable part |
| Single PR | ~350-450 production lines | Two slices recommended |

## Open Questions

- [ ] `PRELIMINARY_SCAN_PAGES = 8` is derived from the 6-page model plus guardas tolerance; the
      first RED test against a real student PDF should confirm the window, not a synthetic one.
- [ ] Whether `metadata.precedence_tier` should also be surfaced in the reviewer UI is left to a
      future change — this design persists it, and displays nothing.
