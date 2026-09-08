# Proposal: Precise Multi-Finding Thesis Review Pipeline

## Intent

Today a review run of a 150-200 page thesis produces **at most one finding** from **one**
LLM call over a flattened full text, with `section_title = null` and every
`document_page_id` / `document_section_id` written as `null`. That is a demo ceiling, not a
product: a reviewer gets one observation for an entire thesis.

This change replaces that ceiling with a real pipeline that walks the **whole document,
page by page and section by section**, and produces **many** findings with exact
page/section provenance, persisted into the schema that already has every required column
(`document_page`, `document_section`, `evidence_snippet`, `finding_evidence`) — no
migration needed. The non-negotiable rule from the MVP survives untouched: no finding
without literal textual grounding.

## Scope

### In Scope

| Deliverable | Detail |
|---|---|
| DOCX→PDF normalization | **RESOLVED, page-accurate DOCX is required (see Question Round #2).** DOCX uploads are converted to PDF via a headless LibreOffice conversion step, then extracted through the same `pypdf` per-page path as native PDFs — one canonical extraction path, real page numbers for both formats. Missing LibreOffice binary fails loudly, never silently degrades to section-only. |
| Section detection | PDF (and now DOCX-via-conversion) heading-heuristic regex over per-page text |
| Real structural persistence | New `insertDocumentPages` / `insertDocumentSections` in `review-repository.mjs`; `persistFinding` receives real FK ids instead of `null` |
| Chunked review loop | `cag_review.py` rewritten: ONE HTTP call from the API per run, worker loops internally over sections/~8-page chunks, returns a **list** of findings. **RESOLVED: no arbitrary per-chunk cap (see Question Round #1/#5)** — every finding that clears the (conservative, false-positive-averse) confidence threshold is returned; volume control comes from confidence filtering, not truncation. |
| Cache-aware provider protocol | `LLMProvider.generate` becomes structured: system + cacheable normative-corpus block (`cache_control` wired) + per-chunk variable content |
| Role-based provider assignment | **RESOLVED (see Question Round #4).** Replaces the single global `is_active` flag with a role-scoped assignment (`judgment`, `triage`, extensible), modeled after `~/.pi/gentle-ai/models.json`'s role→model pattern. `judgment` = final-verdict provider (Claude); `triage` = cheap first-pass provider (real `DeepSeekProvider`, OpenAI-chat-completions-compatible, hand-rolled on the worker's existing `httpx`, per decision `0002`). |
| Deterministic rule engine | Zero-LLM: filler words, long sentences (real sentence segmentation, not `.`-splitting), Spanish spelling (pyspellchecker), in-text-citation vs reference-list cross-check, GT structure presence. Persisted as `producer_type='deterministic_rule'`, independent of and parallel to the LLM path. Confidence thresholds tuned conservative (false-positive-averse) per Question Round #5. |
| Dedup | Fuzzy match on `evidence_text` across adjacent chunks before persistence |

### Out of Scope — deferred on technical grounds, not effort

- **Grammar / agreement / conjugation**: reliable Spanish grammar checking requires
  LanguageTool, a Java runtime in the worker container — disproportionate at this stage.
  Handed to the LLM judgment layer instead, which already reasons about it.
- **APA visual formatting (italics, hanging indent)**: structurally impossible today —
  `pypdf.extract_text()` and `python-docx`'s `.text` discard run-level formatting.
  Becomes possible only once extraction captures runs/fonts; that is a separately scoped
  extraction change, not a skipped check.
- **Groq**: no cheap-triage role distinct from DeepSeek's. Revisit only on concrete need.
- **Embedding RAG over `embedding_record`/pgvector**: the corpus is ~15-20k tokens and fits
  in-context with caching. Real retrieval becomes necessary when the corpus outgrows the
  cacheable window — a clear future trigger, not a present gap.
- **Redis/BullMQ**: processing stays synchronous. This change does not touch the queue
  architecture (still the `mvp-vertical-slice` follow-up).

## Non-Goals (invariants that MUST NOT regress)

1. Never fabricate a finding without literal textual grounding — multi-finding output does
   not relax this.
2. Never persist a `finding` without at least one linked `evidence_snippet`.
3. The deterministic rule path and the LLM path MUST NOT be able to corrupt or block each
   other; a failure in one leaves the other's findings correct and persisted.

## Capabilities

### New Capabilities
- `document-structure-extraction`: page/section boundary detection and persistence with
  explicit uncertainty flags.
- `deterministic-writing-rules`: zero-LLM rule engine emitting `deterministic_rule` findings.

### Modified Capabilities
- `vertical-slice-cag-review`: "at most one finding per review run" becomes bounded
  multi-finding, section-scoped review with real page/section provenance.
- `llm-provider-admin`: a two-tier triage→judgment run needs credentials for two providers
  and provenance for both — today's exactly-one-active model assumes one provider per run.

## Approach

Resolve the exploration's central fork **in favour of Option A**: the API makes one
`/internal/review` call carrying structured page/section data; the worker owns the loop and
the provider/client lifecycle so corpus prompt caching is actually reachable across the
~20-25 chunk calls, and returns all findings in one response. Option B (N calls from Node)
is rejected: caching state becomes implicit across HTTP requests and partial-failure
handling multiplies.

DeepSeek triage is layered **behind** Claude judgment (triage answers "does this chunk
plausibly contain an issue?"), cutting Claude call count. Direction for design: the active
provider stays the judgment provider; triage is opt-in on a separately configured DeepSeek
row; run provenance must record both.

## Cost / Quality Tradeoff

Claude Sonnet 5 at $2/$10 per M input/output tokens (through 2026-08-31). A 150-200 page
thesis ≈ 80k-140k tokens ≈ 20-25 chunk calls per run. With the normative corpus cached
(~10% of base input on hits): **≈$0.60-0.70 per full thesis review**, versus ≈$1.40+
uncached. DeepSeek triage pushes it lower.

Cost is therefore **not** the constraint shaping this scope. The real constraints are
engineering effort and correctness — false positives and false negatives. That is exactly
why the deterministic layer matters as much as the LLM layer: it gives zero-cost,
zero-hallucination-risk coverage of everything genuinely pattern-matchable.

## Relationship to Prior Changes

Builds on `mvp-vertical-slice` and `llm-provider-admin` (both archived). Reuses the
extraction entrypoint, provider-admin credential resolution, and review-run lifecycle
unchanged. Nothing that works today is redesigned — only the review-depth ceiling is
replaced.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `services/worker/app/extraction.py` | Modified | Section detection (PDF heuristic, DOCX styles) |
| `services/worker/app/cag_review.py` | Rewritten | Chunked loop, multi-finding, structured prompts |
| `services/worker/app/providers/llm_provider.py`, `anthropic_provider.py` | Modified | Structured cache-aware protocol |
| `services/worker/app/providers/deepseek_provider.py` | New | Real implementation via `httpx` |
| `services/worker/app/rules/` | New | Deterministic rule engine package |
| `services/worker/app/main.py` | Modified | `/internal/review` contract + longer timeout |
| `services/worker/pyproject.toml` | Modified | Sentence segmentation, pyspellchecker, rapidfuzz |
| `apps/api/src/jobs/review-orchestrator.mjs` | Modified | Multi-finding persistence loop |
| `apps/api/src/db/review-repository.mjs` | Modified | Page/section inserts, real FK wiring |
| `openspec/specs/vertical-slice-cag-review/spec.md` | Modified | Delta spec required |

## Test Rework (deliberate, not silent breakage)

Strict TDD is active (`strict_tdd: true`, runner `pnpm test`). Later phases follow
**RED → GREEN → TRIANGULATE → REFACTOR**. These suites assert the single-finding /
single-call world and require conscious rewrite in the same work units:

- `services/worker/tests/test_cag_review.py` — asserts `len(received_prompts) == 1` and a
  `CagFinding | None` return.
- `apps/api/tests/active-provider-resolution.test.mjs` — exact `deepEqual` on the
  single-shot `/internal/review` body.
- `apps/api/tests/live-review-integration.test.mjs` — asserts `findings === 1`.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Multi-finding output increases fabrication surface | Med | Keep grounding validator; verify claimed `evidence_text` literally exists in source pages before persistence |
| False-positive flood degrades reviewer trust | High | Per-chunk cap, dedup pass, confidence scores, low confidence on fuzzy heading matches |
| Heading heuristic misses sections | Med | Fall back to fixed page chunks; set `is_location_uncertain` honestly |
| Anthropic caching API shape / cache-write premium drifts | Med | Re-verify against current docs at implementation; caching is an optimization, not a correctness dependency |
| Two-provider run breaks one-active-provider provenance | Med | Explicit design decision required before DeepSeek triage lands; triage ships last |
| Change exceeds the 400-line review budget | High | `sdd-tasks` must plan a chained PR split: (1) section detection + persistence, (2) deterministic rules, (3) chunked LLM review + protocol, (4) DeepSeek triage |
| New Python deps inflate worker image | Low | Prefer lightweight segmentation; measure image size delta |

## Rollback Plan

Each chained slice is independently revertable. Per slice: `git revert` the slice commit.
No migration is introduced, so no schema rollback exists; new `document_page` /
`document_section` rows become inert if the writing code is reverted. The
`vertical-slice-cag-review` main spec is only updated at archive time, so a pre-archive
abort leaves `openspec/specs/` untouched. Reverting the provider-protocol slice restores
the flat `generate(prompt)` signature and single-call review; DeepSeek returns to a stub.

## Dependencies

- Active `llm_provider_config` row per role (`judgment` required; `triage` optional — existing `llm-provider-admin` behavior extended per Question Round #4).
- Anthropic prompt-caching availability on the configured Claude model.
- DeepSeek credentials, for the triage slice only.
- New worker Python deps: Spanish sentence segmentation, `pyspellchecker`, `rapidfuzz`.
- LibreOffice headless binary installed on the worker's host (DOCX→PDF conversion, required per Question Round #2 — not optional).

## Success Criteria

- [ ] A full 150-200 page thesis run produces **many** findings (not ≤1), each with
      non-empty `evidence_text` and a real `document_page_id` or `document_section_id`
      (or an explicit uncertainty flag).
- [ ] `document_page` and `document_section` rows are populated for every completed run.
- [ ] Deterministic-rule findings are persisted with `producer_type='deterministic_rule'`
      and are produced with **zero** LLM calls.
- [ ] A forced failure in the LLM path still persists deterministic findings, and vice versa.
- [ ] No finding is persisted whose `evidence_text` is absent from the source document.
- [ ] Adjacent-chunk duplicate findings are collapsed before persistence.
- [ ] Corpus prompt caching is observably active (cache-read tokens > 0 after the first
      chunk call).
- [ ] Measured cost of one full review run is recorded and within the same order as the
      ~$0.60-0.70 estimate.
- [ ] `pnpm test` green, with the three rewritten suites asserting multi-finding behavior.

## Proposal Question Round — RESOLVED

The user answered all open questions directly. These are now locked decisions, not
assumptions, and `sdd-spec`/`sdd-design` must follow them exactly:

1. **Finding volume vs. reviewer load — RESOLVED: full list, no cap.** Return every
   genuinely evidence-grounded finding from a full review run, grouped/sorted by
   severity for reviewer triage. No arbitrary top-N truncation.
2. **DOCX provenance — RESOLVED: page-accurate citation is required, not optional.**
   Section-only provenance for DOCX is REJECTED. `sdd-design` must specify a real
   DOCX pagination mechanism — the explore-recommended path is converting DOCX to PDF
   via a headless LibreOffice conversion step, then extracting through the *same*
   `pypdf`-based per-page path already built and proven for native PDF uploads (this
   also means DOCX and PDF end up sharing one extraction code path instead of two).
   This is a new infra dependency (LibreOffice headless binary must be installed on
   the worker's host) — `sdd-design` must document exact install/invocation and a
   fallback error path if the binary is missing (fail loudly, never silently degrade
   to section-only).
3. **Spanish-only — carried as-is, not re-asked.** Confirmed out of scope for now;
   the normative corpus itself is Spanish-only (UMG guidelines), so this was never
   really in question.
4. **DeepSeek triage credentials — RESOLVED: separate triage-role provider config
   (proposal's recommended option), modeled as ROLE-BASED provider assignment, not a
   bolt-on second "active" flag.** The user pointed to `~/.pi/gentle-ai/models.json` as
   the reference pattern to follow: a flat mapping of ROLE → (provider/model, effort
   tier) — e.g. `"sdd-apply": {"model": "lmstudio-local/local-mid", "thinking":
   "medium"}`. `sdd-design` must specify PG1's equivalent: replace (or extend)
   `llm_provider_config`'s single global `is_active` boolean with a role-scoped
   assignment (e.g. a `role` column + a composite partial unique index enforcing
   exactly-one-active-per-role, roles starting with `judgment` and `triage`, extensible
   later). The `judgment` role is the final-verdict provider (Claude today); `triage`
   is the cheap first-pass provider (DeepSeek). `review_run.llm_provider_name`/
   `llm_model_id` provenance must record which provider served which role for that run.
5. **False positives vs. misses — RESOLVED: bias toward fewer false positives.**
   Confidence thresholds (both deterministic-rule and LLM-based) should be tuned
   conservative — a missed real issue is preferred over flagging a non-issue. This
   directly informs `sdd-design`'s per-chunk finding cap and confidence-threshold
   defaults, and REVERSES this proposal's earlier "small safety cap, e.g. 5-10" framing
   for the *cap* (no cap, per #1) while still applying to *confidence filtering*
   (stricter minimum confidence to persist a finding at all).
