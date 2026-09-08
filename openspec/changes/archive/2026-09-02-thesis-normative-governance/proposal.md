# Proposal: Thesis Normative Governance Harness

## Intent

Every deterministic rule finding is persisted with `normativeSourceId: null` (hardcoded in `review-orchestrator.mjs` ~line 237), so no reviewer can tell which institutional document justified a finding. The three real source documents disagree — the library Reglamento's margins/spacing/pagination directly contradict generic APA 6 formatting, and the Facultad guide's own text subordinates APA to the Reglamento. Without declared source provenance and precedence, the system cannot explain or arbitrate its own findings, which breaks the audit-trail and ethics goal.

## Scope

### In Scope

- Migration: `normative_source.precedence INTEGER` + new Reglamento `source_type` value (reglamento=1, apa_6=2, gt_guide=3).
- `NORMATIVE_SOURCE_TYPE` constant per rule module, threaded `RuleFinding` → `persistFinding` → `finding.normative_source_id`; removes the hardcoded `null`.
- New Reglamento-grounded rule module: preliminary-page sequence/titles (carátula exterior, carátula interior, autoridades y tribunal, autorización de impresión, Artículo 8, índice) and verbatim Artículo 8° "Responsabilidad" text.
- APA-6 additions to `citations.py`: et-al. thresholds (1–2 always both; 3–5 et al. from 2nd mention; 6+ from 1st), quote length (<40 words inline/quoted vs ≥40 block), reference-entry shape.
- Precedence harness Part 1 (per-finding provenance + `precedence_tier` metadata) and Part 2 (conflict-grouping/demotion hook in `run_rules()`).

### Out of Scope

- All physical-layout rules (margins, spacing, font, pagination position, hanging indent, italics) — blocked on a layout-aware extraction rework; `extraction.py` is text-only (`pypdf`).
- Portada/contraportada visual requirements (escudo size, cartulina) — permanently outside automated scope.
- APA 7 rules. No supplied source document mentions APA 7; fabricating them is forbidden. A future change with a real APA 7 document may add them.
- `review_workflow_item.approval_state`. This change produces `finding` rows only and adds no path to that human-only gate.
- `precise-thesis-review-pipeline` PR3–PR7 (DOCX conversion, provider protocol, chunked loop, provider roles).

## Capabilities

### New Capabilities

- `normative-source-governance`: normative source registry with precedence, per-finding source provenance, and precedence-based conflict arbitration.
- `reglamento-structure-rules`: text-checkable preliminary-page and verbatim-text checks grounded in the library Reglamento.

### Modified Capabilities

- `deterministic-writing-rules`: rule findings must declare their normative source; `citations.py` gains APA-6 edition-specific requirements. Note: this capability currently lives as a delta spec inside `precise-thesis-review-pipeline` (unarchived) — `sdd-spec` must resolve where the delta lands.

## Approach

Exploration Approach 3: standalone change, single PR, sequenced before `precise-thesis-review-pipeline` PR3 resumes (PR3–PR7 are unstarted and orthogonal, and PR4/PR5 will rewrite `main.py`'s `/internal/review` contract).

1. Migration adds `precedence` and the Reglamento `source_type`; seeds the three sources with their tiers.
2. `base.py` gains a source-type field on `RuleFinding`; each module declares `NORMATIVE_SOURCE_TYPE` (same module-constant pattern as `MIN_RULE_CONFIDENCE`). `gt_structure.py` is re-tagged only.
3. Orchestrator resolves the real id via the existing `resolveNormativeSourceId`, replacing `null`.
4. New Reglamento module + APA-6 `citations.py` additions, each written test-first.
5. `run_rules()` post-processing groups findings by `conflict_key` and demotes higher-tier-number duplicates to `superseded_by_higher_precedence` metadata.

Invariants carried forward: no finding without literal textual grounding (`evidence_text` required); no rule may touch `approval_state`; no rule grounded in anything but the three real source documents.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/api/src/db/migrations/000X_normative_governance.sql` | New | `precedence` column, Reglamento `source_type`, possible `finding_type` value |
| `apps/api/src/jobs/review-orchestrator.mjs` | Modified | Replace hardcoded `normativeSourceId: null` |
| `services/worker/app/rules/base.py` | Modified | Source-type field on `RuleFinding` |
| `services/worker/app/rules/citations.py` | Modified | APA-6 et-al., quote-length, reference-shape rules |
| `services/worker/app/rules/gt_structure.py` | Modified | Tag `gt_guide` |
| `services/worker/app/rules/reglamento_structure.py` | New | Preliminary pages + Artículo 8° verbatim |
| `services/worker/app/rules/__init__.py` | Modified | Register module; precedence post-processing hook |
| `apps/api/src/db/review-repository.mjs` | Unchanged | `persistFinding` already accepts `normativeSourceId` |
| `services/worker/app/extraction.py` | Unchanged | Named blocker for deferred layout rules |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| No real conflict exists to exercise Part 2 (all proven conflicts are layout-only) | High | Build the hook correctly; document as a known limitation; use a deliberately-constructed unit fixture for TDD rather than claiming production coverage |
| Roman-numeral preliminary pages may not be captured by current extraction/section detection | Medium | `sdd-spec`/`sdd-design` must verify against real extraction output before writing preliminary-page requirements |
| `finding.finding_type` CHECK has no structural value | Medium | Explicit design decision: extend the CHECK or reuse `gt` — not assumed |
| Coordination with `precise-thesis-review-pipeline` (shared `review-orchestrator.mjs`) | Medium | Land before PR3 resumes; touches a different route/function |
| Over-promising physical-format coverage to reviewers | Medium | Out-of-scope list is normative, restated in specs and UI-facing wording |

## Rollback Plan

Single PR, revertable as one commit. Migration rollback: drop `normative_source.precedence`, revert the `source_type` CHECK to its prior value set, delete any Reglamento rows. Code rollback restores `normativeSourceId: null` and removes the new rule module — existing findings are unaffected because the column is nullable and pre-existing rows already hold `null`. No `review_workflow_item` data is touched, so the approval gate cannot be corrupted by a revert.

## Dependencies

- `precise-thesis-review-pipeline` Work Units 1–5 (section detection + deterministic rule engine) — already complete.
- The three real source documents (Facultad guide, APA 6 manual, library Reglamento) as the only admissible grounding.

## Open Questions

- Where does the `deterministic-writing-rules` delta land while `precise-thesis-review-pipeline` is unarchived?
- Extend `finding.finding_type` CHECK with a structural value, or reuse `gt`?
- Does extraction currently emit roman-numeral preliminary pages as `document_page`/`document_section` rows?
- Are normative sources seeded by migration, or by an admin-managed registry?

## Success Criteria

- [ ] Zero deterministic rule findings persist with `normative_source_id = null`.
- [ ] Each of the three source types resolves to a distinct `precedence` tier in `normative_source`.
- [ ] Reglamento module flags a missing/mis-ordered preliminary page and a missing/altered Artículo 8° text, with literal evidence.
- [ ] `citations.py` flags each APA-6 et-al. threshold case and both quote-length cases.
- [ ] Conflict hook demotes the lower-precedence finding for a shared `conflict_key` in unit tests.
- [ ] No code path in this change can read or write `review_workflow_item.approval_state`.
