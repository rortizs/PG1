# Exploration: Thesis Normative Governance Harness

## Current State

**Rule engine (`services/worker/app/rules/`)** — read in full:
- `base.py`: `RuleFinding` frozen dataclass (`finding_type`, `severity`, `confidence`, `title`, `explanation`, `recommendation`, `evidence_text`, `page_number`, `section_index`, `rule_id`, `metadata`, `producer_type='deterministic_rule'`, `producer_id='rules@v1'`). No field exists today for normative-source linkage (no `normative_source_id`, no `source_type`, no `precedence`). `fold()` is the shared accent/case-fold normalizer.
- `__init__.py`: `run_rules(pages, sections)` iterates 5 modules (`filler_words, long_sentences, spelling, citations, gt_structure`), filters by `MIN_RULE_CONFIDENCE=0.70`. Structurally forbidden from importing `app.providers.*` (enforced by an AST-based import-boundary test). Natural extension point for new modules and for any conflict/precedence post-processing.
- `citations.py`: generic not-edition-aware regex cross-check — extracts `(Author, YYYY)` in-text citations and `Author, X. (YYYY).` reference-list lines, flags citation-without-reference and reference-without-citation. No et-al.-threshold logic, no quote-length (<40/≥40 words) logic, no reference-format (hanging indent, italics) checks — none of the real APA 6 rules from the grounding digest are implemented.
- `gt_structure.py`: checks 7 required body sections (introducción, marco teórico, marco metodológico, conclusiones, recomendaciones, bibliografía/referencias, anexos) against detected `document_section` titles — grounded in the Facultad guide's corpus text. Skips cleanly (no finding) when zero sections detected. Facultad-guide-grounded rule, reasonably solid already; only needs re-tagging with a `source_type`.
- `filler_words.py`/`long_sentences.py`/`spelling.py`/`segmentation.py`: writing-style rules, not in scope for this change.

**DB schema already has governance-relevant infrastructure that is under-used**, confirmed by reading `apps/api/src/db/migrations/0001_schema_baseline.sql`:
- `normative_source(source_type IN ('gt_guide','apa_6','rubric','example_observation'), version_label, is_approved, ...)` — `apa_6` already exists as a value; there is no `source_type` for the library/form Reglamento (the user's highest-priority document) and no `precedence` column at all.
- `finding.normative_source_id BIGINT REFERENCES normative_source(id)` — the FK already exists.
- `finding.finding_type CHECK IN ('gt','apa','writing_style','grammar','congruence','methodology','rag_review')` — no value for physical/preliminary-page structure; would need `'gt'` reuse or a new value + migration.
- `audit_event(entity_type, entity_id, event_type, message, metadata, ...)` — a generic append-only audit table already exists and is already used by `review-run-lifecycle.mjs`, but never for normative-source/governance events.

**Critical wiring gap confirmed by reading `apps/api/src/jobs/review-orchestrator.mjs`**: the deterministic-rules persistence call (`persistFinding`, line ~237-239) hardcodes `normativeSourceId: null` for every rule-engine finding. Only the separate CAG/RAG path (line ~297, via `resolveNormativeSourceId`) ever populates `normative_source_id`. Today, zero deterministic findings (citations.py, gt_structure.py, etc.) carry any normative-source provenance, even though the DB column has existed since the baseline migration. This is the single clearest, most concrete gap the new change should close, and it directly serves the ethics/audit-trail goal at near-zero schema cost.

**Extraction is text-only, confirmed by reading `services/worker/app/extraction.py`**: uses `pypdf.PdfReader.extract_text()` (plus `python-docx` for `.docx`). No layout/bounding-box/font metadata is captured. This is a hard technical constraint on scope: margin size, line spacing, font, pagination position, hanging indent, and italics — the majority of the "physical format" rules in both the APA-6 manual and Reglamento Articles 30-37/50 — are NOT checkable against the current extraction output. Only text-content-level rules (presence/absence of required sections, presence of exact required verbatim text like Artículo 8°, presence of expected preliminary-page titles in expected order, author/year citation patterns, et al. usage) are checkable without a separate, nontrivial extraction rework (e.g. swapping/augmenting `pypdf` with a layout-aware library such as `pdfplumber` or `pymupdf`).

**Human-approval gate, confirmed via `openspec/specs/reviewer-workflow-board/spec.md` and `apps/api/src/db/migrations/0004_review_workflow_item.sql`**: `review_workflow_item.approval_state` defaults `'not_approved'`, is a completely separate table from `finding`/`review_run`, and per spec ("Approval is human-controlled") is only ever transitioned to `'approved'` by an explicit reviewer action — never derived from analysis/finding data. This new change operates entirely upstream of that gate (it only produces `finding` rows); there is no code path today, and none this change would need to add, that lets any rule or LLM output set `approval_state`. The gate is structurally safe from this change by construction, not by convention.

**`precise-thesis-review-pipeline` status**: Work Units 1-5 (PR1 section detection+persistence, PR2 deterministic rule engine) are checked `[x]` complete in `tasks.md`. Work Units 6-10 (PR3 DOCX→PDF, PR4 breaking provider protocol, PR5 chunked review loop, PR6 role-based provider assignment, PR7 real DeepSeek triage) are unchecked and orthogonal — they are about *how* extraction/LLM-review scales and which model plays which role, not about *which normative rules apply or with what precedence*. PR6's role→provider pattern is explicitly modeled on gentle-ai's `models.json` role→model file per the change's own design notes, but it resolves LLM providers, not normative rulesets — a structurally different axis from what this exploration is scoping (confirmed by rereading `design.md`'s D7 table: it only touches `provider-config-repository.mjs`/`admin-contract.mjs`/`live-review-pipeline.mjs`/admin UI, nothing in `app/rules/`).

## Affected Areas

- `services/worker/app/rules/base.py` — `RuleFinding` needs a `normative_source_type` (or equivalent) field so every rule module can self-tag which source family it belongs to.
- `services/worker/app/rules/citations.py` — needs APA-6-grounded rules added (et-al. thresholds by author count, quote-length ≥40/<40 words, reference-entry-shape checks), tagged `source_type='apa_6'`.
- `services/worker/app/rules/gt_structure.py` — re-tag only (`source_type='gt_guide'`), logic is already reasonably grounded.
- `services/worker/app/rules/` — new module(s) for library-Reglamento-grounded checks: preliminary-page sequence/verbatim-text checks, tagged with a new `source_type` for the Reglamento family (does not exist in the DB enum yet).
- `services/worker/app/rules/__init__.py` — extension point for registering new modules and (optionally, see Recommendation) a precedence/conflict post-processing hook.
- `apps/api/src/db/migrations/000X_normative_governance.sql` (new) — add `normative_source.precedence INTEGER`, extend `normative_source.source_type` CHECK with the missing Reglamento value, optionally extend `finding.finding_type` CHECK for a physical-structure finding type.
- `apps/api/src/jobs/review-orchestrator.mjs` — fix the hardcoded `normativeSourceId: null` on the rules-persistence path; resolve it the same way the CAG path already does via `resolveNormativeSourceId`.
- `apps/api/src/db/review-repository.mjs` — `persistFinding` already accepts `normativeSourceId`; no signature change needed, only real values from the caller.
- `openspec/specs/reviewer-workflow-board/spec.md`, `apps/api/src/db/migrations/0004_review_workflow_item.sql` — read-only reference points proving the approval gate is untouched by this change.
- `services/worker/app/extraction.py` — NOT modified by this change's recommended v1 scope, but is the named blocker for any future physical-layout rule (margins/spacing/font/pagination-position); called out explicitly as an out-of-scope dependency, not silently ignored.

## Approaches

### 1. Amend `precise-thesis-review-pipeline` in place (fold governance work into PR3-PR7 or a new PR inserted before them)
- Pros: single change/PR chain to track; reuses the already-cached `auto-chain`/`stacked-to-main` delivery strategy and 400-line budget forecast without renegotiating it.
- Cons: PR3-PR7 are orthogonal (DOCX conversion, breaking provider protocol, chunked review loop, provider role admin, DeepSeek triage) — none of them touch `app/rules/` or `normative_source`. Folding governance in would either bloat an already-High-risk review-workload forecast or force artificial interleaving with unrelated PRs, weakening the "each PR has a clear, independent finish and rollback boundary" property the existing tasks.md already established. Also would blur the change's own proposal/design scope after they've already been through spec/design/tasks for the current 7-PR plan.
- Effort: Medium-High (mostly coordination/document-surgery cost, not code cost).

### 2. New standalone SDD change scoped specifically to normative governance
- Pros: clean, single-concern scope. Independently reviewable and independently revertable from PR3-PR7. Can start immediately — only depends on the already-complete Work Units 1-5, not on any pending PR3-PR7 work. Matches the DB schema's own separation of concerns.
- Cons: a second concurrently-active SDD change means two `state.yaml` trees to track; must be explicit that this change does not touch `services/worker/app/providers/`, `cag_review.py`'s chunk loop, or the provider-role migrations. Both changes touch `main.py` and `review-orchestrator.mjs`, just different routes/functions in each.
- Effort: Medium (new migration, new rule modules following an existing, well-established pattern, one orchestrator wiring fix).

### 3. Hybrid — new change, sequenced to land between PR2 (done) and PR3 (DOCX conversion)
- Pros: same isolation benefits as (2), plus avoids interleaving risk entirely by finishing before PR3-PR7 restart; the `main.py`/orchestrator touch points are the smallest and most stable they'll ever be (before the breaking provider-protocol rewrite in PR4/PR5 changes `main.py`'s `/internal/review` contract).
- Cons: requires explicitly pausing `precise-thesis-review-pipeline`'s PR3 rather than parallelizing — a light process cost, not a technical one.
- Effort: Medium (same as 2), lower integration risk than 2.

## Recommendation

**Approach 3**: open a new, standalone SDD change (`thesis-normative-governance`) scoped to:

(a) a `normative_source.precedence` column + a new Reglamento `source_type` value (library reglamento = 1 highest, apa_6 = 2, gt_guide = 3 — matching the user's explicit, PDF-grounded priority order) via one small migration;
(b) tagging every existing and new rule module with the `source_type` it belongs to, threaded through `RuleFinding` → `persistFinding` → `finding.normative_source_id`, fixing the currently-hardcoded `null`;
(c) new Reglamento-grounded rule module(s) for preliminary-page sequence and required verbatim text (Artículo 8°), scoped to what's actually checkable from text-only extraction;
(d) APA-6-grounded additions to `citations.py` (et-al. thresholds, quote-length rule), explicitly scoped to text-checkable rules only;
(e) explicitly deferring/flagging (not silently dropping) every physical-layout rule (margins, spacing, font, pagination position, hanging indent, italics) as blocked on a future extraction-pipeline change, so the gap is documented rather than invisible.

Sequence its single PR before `precise-thesis-review-pipeline` PR3 resumes, since PR3-PR7 are unstarted and orthogonal — this avoids any risk of the breaking provider-protocol (PR4) or contract rewrite (PR5) landing concurrently with this change's smaller, unrelated touches to `main.py`/`review-orchestrator.mjs`.

### Precedence/conflict-resolution mechanism

Design it as a genuine two-part harness, honestly scoped:

- **Part 1 (build now, real and useful immediately)**: every rule module declares a `NORMATIVE_SOURCE_TYPE` constant (mirroring `MIN_RULE_CONFIDENCE`'s module-level-constant pattern already used in `base.py`), which flows through `RuleFinding` into `finding.normative_source_id` and into finding metadata as an explicit `precedence_tier` value. This alone gives every reviewer full transparency ("this finding was justified by the Reglamento, tier 1" / "by APA 6, tier 2"), and is genuinely gentle-ai-harness-like (a declared, machine-readable authority tag per producer) even before any real conflict ever fires.
- **Part 2 (design the hook now, but do not force fake conflicts to prove it)**: `run_rules()` gains an optional post-processing step that groups findings sharing a `conflict_key` metadata tag and keeps only the lowest-`precedence_tier` finding when two fire for the same concrete requirement, demoting the rest to a `superseded_by_higher_precedence` metadata note rather than a duplicate/contradictory finding. Given the text-only extraction constraint, no real rule-vs-rule conflict currently exists to arbitrate — the proven conflict from the grounding digest (margins, spacing, pagination position) is entirely in the physical-layout space this change cannot check yet. Build the hook so it is correct and ready, but do not manufacture a synthetic conflict just to exercise it; document this explicitly as a known, deliberate limitation rather than claiming false completeness.

## Risks

- Physical-layout rules are not checkable with the current text-only extraction pipeline (`pypdf`, confirmed by reading `extraction.py`). Any spec/design for this change must explicitly scope OUT margin/spacing/font/pagination-position/indent/italics checks, or it will over-promise. A future extraction-pipeline rework (layout-aware library) is a real, separate prerequisite for closing that gap — not this change's job to solve.
- `finding.finding_type` CHECK constraint has no value for physical/preliminary-structure findings; the new change must either add a migration extending it or deliberately reuse `'gt'`/`'apa'` — needs an explicit design decision, not an assumption.
- Portada/contraportada visual requirements (escudo size, cartulina color, exact print-order fidelity) are physically-printed-artifact requirements, not text-checkable at all, regardless of extraction library — these should be documented as permanently out of automated scope, addressed by the existing library reglamento's own physical review process, not simulated by this system.
- Overlap risk with `precise-thesis-review-pipeline` PR4/PR5: both eventually touch `main.py` and `review-orchestrator.mjs` (different routes: `/internal/rules` vs `/internal/review`), so sequencing before PR3 resumes (as recommended) meaningfully reduces, but does not fully eliminate, coordination risk if delivery timing shifts.
- No real precedence conflict exists yet to test the arbitration logic against — Part 2 of the recommended design (conflict grouping/demotion) will ship without a real triangulating test case unless a synthetic one is deliberately constructed for TDD purposes; this must be flagged to whoever writes the spec/design/tasks so RED/GREEN/TRIANGULATE isn't quietly skipped for that piece.
- The library reglamento PDF's exact section/page structure (preliminary pages i-vi) needs to be cross-referenced against what `gt_structure.py`'s sibling module will actually receive as `document_section`/`document_page` data — preliminary pages (roman numerals) are a distinct numbering regime from body pages (arabic), and it's not yet confirmed whether `extraction.py`'s current page/section detection captures roman-numeral preliminary pages at all (needs verification in `sdd-spec`/`sdd-design`, not assumed here).

## Ready for Proposal

Yes. Findings are grounded in real code (`base.py`, `citations.py`, `gt_structure.py`, `__init__.py`, `extraction.py`, `review-orchestrator.mjs`, `0001_schema_baseline.sql`, `0004_review_workflow_item.sql`) and the two prior grounding artifacts (architecture dictamen, normative-source PDF digest). Proceed with `sdd-propose` for this standalone change, scoped per the Recommendation above, sequenced before `precise-thesis-review-pipeline` PR3 resumes.
