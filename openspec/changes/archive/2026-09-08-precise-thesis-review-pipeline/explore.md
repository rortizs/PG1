# Exploration — Precise, evidence-cited multi-finding thesis review pipeline

Replaces the "at most one finding" MVP slice with a real product capability: precise,
exact, evidence-cited review of a full 150-200 page thesis. This is a deliberate
completeness-first change per the user's explicit direction ("enfócate en un producto
funcional, ya no en un MVP") — not another thin demo slice with documented shortcuts.

## Current State

**Extraction (`services/worker/app/extraction.py`)**: PDF already returns real per-page
`ExtractedPage(page_number, section_title=None, text)` via `pypdf` (lines 63-82). DOCX
returns exactly ONE `ExtractedPage(page_number=None, section_title=None, text=<entire doc>)`
blob (lines 85-97) — explicit docstring: "DOCX has no fixed page concept without
rendering (out of scope: no layout analysis)". `section_title` is `None` for every
page/format — zero section-boundary detection exists anywhere.

**LLM review (`services/worker/app/cag_review.py`)**: `run_cag_review()` does exactly
ONE call. `build_prompt()` (lines 87-92) concatenates the ENTIRE normative corpus
(`data/academic-rules/*.txt`, ~1,300 lines, all 4 files) + the ENTIRE `thesis_text` into
one flat string, sent via `provider.generate(prompt)`. `SYSTEM_PROMPT` (lines 36-53) is
embedded in that same flat string (not passed as Anthropic's dedicated `system` param)
and explicitly instructs "AT MOST ONE issue". Return type is `CagFinding | None`, never
a list. Confirmed no `cache_control`/caching reference anywhere in `services/worker/`
(grep: 0 matches).

**Orchestration (`apps/api/src/jobs/review-orchestrator.mjs`)**: line 105 confirms
`thesisText = extraction.fullText ?? extraction.full_text ?? ""` — the FULL extracted
text is forwarded (not an excerpt). Lines 111-137: at most one `finding` is persisted,
with exactly one `evidence` entry hardcoded.

**Provider layer**: `LLMProvider.generate(prompt: str, *, max_tokens=1024) -> str` is a
flat-string-in/string-out signature — no room for structured cacheable message blocks.
`AnthropicProvider.generate()` builds `messages=[{"role": "user", "content": prompt}]`
with no `system` param and no `cache_control`. `DeepSeekProvider`/`GroqProvider` are
genuine stubs — `.generate()` always raises `ProviderNotImplementedError`.
`services/worker/pyproject.toml` deps: `fastapi, uvicorn, python-multipart, pypdf,
python-docx, anthropic, httpx` — no `openai`/spaCy/NLP libs today.

**Schema (`apps/api/src/db/migrations/0001_schema_baseline.sql`)**: `document_page`,
`document_section` (with self-FK hierarchy, section_type, offsets, uncertainty flags),
`evidence_snippet` (page/section FKs, uncertainty flags, unused `context_before`/
`context_after`), `finding` (`finding_type` already includes `gt`/`apa`/`writing_style`/
`grammar`/`congruence`/`methodology`/`rag_review`; `producer_type` already includes
`deterministic_rule`/`ai_assisted`/`controlled_rag`/`agentic_rag`), `finding_evidence`
(join table, already supports multi-evidence findings), `normative_segment`+
`embedding_record` (pgvector(1536), RAG-ready) — ALL columns needed for multi-page/
section/finding review already exist. **The one real gap**: `apps/api/src/db/
review-repository.mjs` has ZERO insert/select functions for `document_page` or
`document_section` (grep confirms only the repository file and the migration SQL
reference those tables) — `persistFinding()` accepts `documentPageId`/`documentSectionId`
as optional params but every current caller passes `null`. Schema is fully ready;
application code to populate it doesn't exist.

## Affected Areas

- `services/worker/app/extraction.py` — needs section-boundary detection for both formats; DOCX provenance strategy decision
- `services/worker/app/cag_review.py` — core rewrite: single-call/single-finding -> chunked multi-call/multi-finding, prompt structure for caching
- `services/worker/app/providers/llm_provider.py` + `anthropic_provider.py` — protocol signature change needed for structured/cacheable messages
- `services/worker/app/providers/unimplemented_provider.py` -> new `deepseek_provider.py` — real implementation
- `services/worker/app/main.py` — `/internal/review` request/response contract likely needs to change shape
- `services/worker/app/rules/` (does not exist yet) — new deterministic rule engine package
- `services/worker/pyproject.toml` — new deps decision (spaCy Spanish model, pyspellchecker, rapidfuzz)
- `apps/api/src/jobs/review-orchestrator.mjs` — multi-finding persistence loop, one call vs N calls to worker decision
- `apps/api/src/db/review-repository.mjs` — new `insertDocumentPages`/`insertDocumentSections`, `persistFinding` wiring real FK ids
- `services/worker/tests/test_cag_review.py`, `apps/api/tests/review-repository.test.mjs`, `apps/api/tests/active-provider-resolution.test.mjs`, `apps/api/tests/live-review-integration.test.mjs` — all assume single-call/single-finding; deliberate rewrite required
- `openspec/decisions/0002-llm-provider-strategy.md` — DeepSeek routing intent (bulk/triage) becomes realizable

## Approaches

### 1a. Extraction/section-detection

1. **Heading-heuristic regex + `python-docx` paragraph styles** — PDF: regex over already-extracted per-page text for heading patterns. DOCX: use `paragraph.style.name` (Heading 1/2/Title), already available in python-docx, unused today.
   - Pros: zero new heavy deps, honest with schema's uncertainty flags, low effort.
   - Cons: heuristic, not layout-perfect.
   - Effort: Low-Medium.
2. **Font-size/layout-based (pdfplumber) for PDF; DOCX->PDF render (LibreOffice headless) for true pagination**
   - Pros: more accurate.
   - Cons: heavy new deps, fragile container dependency, over-engineered given DOCX pagination is inherently undefined.
   - Effort: High.
   - **Recommendation**: Option 1 for PDF; for DOCX, do NOT chase real pagination — document DOCX findings as section-scoped with `is_page_uncertain=true`, exactly matching the schema's built-in uncertainty design.

### 1b. Deterministic rule engine (old WU9/WU10 categories)

- Muletillas/filler words: pure regex/lexicon, zero LLM, Low effort, genuinely deterministic.
- Long sentences: needs real sentence segmentation (naive `.` split breaks on abbreviations) — a lightweight Spanish sentencizer (spaCy `es_core_news_sm`) is warranted before the trivial length check. Medium effort.
- Gerunds/passive voice: pure regex is unreliable in Spanish (false positives, misses reflexive passive) — genuinely benefits from POS parsing (spaCy). Recommend regex-first with low confidence, escalate only if false-positive rate demands it.
- Spelling: feasible deterministically now via `pyspellchecker` (Spanish dictionary). Low-Medium effort, zero LLM.
- Grammar (agreement/conjugation): genuinely hard without LanguageTool (Java-based, heavy) — recommend deferring to the LLM judgment layer rather than adding a Java dependency now.
- GT structure checks: deterministic matching of detected sections against the expected structure list in `tesis_guia_trabajo_gt.txt`/`plantilla_sugerida_trabajo_graduacion.txt` — feasible with zero LLM, accuracy bounded by section-detection quality.
- APA citation/reference consistency: in-text citation regex cross-referenced against the reference list is genuinely deterministic (zero LLM). Real APA *formatting* checks (italics, hanging indent) are structurally blocked today because extraction strips run-level formatting — `python-docx` CAN expose `run.italic` but doesn't use it; PDF formatting would need pdfplumber/font inspection. Recommend citation-presence cross-check now; explicitly scope out formatting-level checks as a documented follow-up.
- `rag-citation`-style lib (SpaCy NER + SentenceTransformers, evaluated earlier this session): reconsidered — better suited to (a) a fabrication-guard verifying an LLM-claimed `evidence_text` is truly present in the source pages, and (b) embedding-based retrieval into the already-ready `embedding_record`/pgvector once the corpus grows — not the deterministic writing-style layer, which is proportionate to pure regex + spaCy.
- **Recommendation**: build muletillas, long-sentence, spelling, citation cross-check, and GT structure-presence now (zero LLM); gerunds/passive as regex-first-with-low-confidence; grammar and APA-formatting explicitly deferred with documented rationale.

### 2. Multi-finding, section-scoped LLM review architecture

1. **Chunk-per-section/N-page, worker-internal loop, one HTTP call from Node** — Node calls `/internal/review` once per review run with structured page/section data; the worker loops internally over `document_section`s (or ~8-page chunks when detection is unreliable), reusing one provider/client across the loop so caching is actually exploitable, returns a list of findings.
   - Pros: simple Node<->worker contract shape (still request-in/response-out), worker owns the caching-aware client lifecycle, single round-trip.
   - Cons: significant `/internal/review` schema change; needs a longer timeout than today's 30s.
   - Effort: Medium-High.
2. **Node drives N separate HTTP calls to `/internal/review`, one per chunk**
   - Pros: smaller per-call contract change.
   - Cons: caching state implicit/unclear across N HTTP requests, N round-trips, more complex partial-failure handling.
   - Effort: Medium.
   - **Recommendation**: Option 1 — this is the central design fork that `sdd-propose`/`sdd-design` must resolve explicitly.
- Prompt structure for caching: system (small, cacheable) + normative corpus block (large, cacheable via `cache_control`, verify exact API shape at implementation time) + per-chunk variable content (never cached). Change `run_cag_review()`'s "AT MOST ONE issue" to "as many genuinely grounded issues as found in this section" with a small per-call cap (5-10) as a safety valve.
- Dedup: adjacent-chunk boundary duplicates are a real risk — small context-overlap marked "context only", or a cheap post-pass fuzzy-match (`rapidfuzz`) on `evidence_text` before persistence.
- **Cost/call estimate** (directional, grounded in given pricing: $2/$10 per M input/output tokens through Aug 31 2026, cache hits ~10% of base input, cache writes carry a premium — verify exact multiplier at implementation time): 150-200 pages ≈ 80k-140k tokens; at ~8 pages/chunk that's ~20-25 chunks/calls per review run. Corpus (~15-20k tokens) cached after the first call. Rough total: **~$0.6-0.7 per full thesis review run with caching**, vs. **~$1.4+ without caching** — a real, material lever at this call count.

### 3. Provider protocol change for caching

- Change `LLMProvider.generate(prompt: str, ...)` to a structured shape (system + cached corpus block(s) + variable content) — a genuine breaking change touching `AnthropicProvider`, the stub providers, and `cag_review.py`'s prompt-building code.
- DeepSeek note: documented behavior is automatic backend caching (no explicit flag needed, unlike Anthropic) — verify against current docs; the structured-message protocol still helps organize content cleanly regardless.
- Effort: Medium.

### 4. DeepSeek real implementation

- OpenAI-chat-completions-compatible API — recommend hand-rolling via `httpx` (already a worker dependency) rather than adding the `openai` SDK, mirroring `AnthropicProvider`'s pattern exactly (lazy import, lazy key resolution, explicit error types).
- Fits as a cheap triage pass ahead of Claude (does this chunk plausibly contain an issue?), directly reducing the Claude call count from point 2 — matches `openspec/decisions/0002-llm-provider-strategy.md`'s routing table.
- Effort: Low-Medium for the provider; Medium for wiring the two-tier triage->judgment flow.

### 5. Schema/persistence

- No migration needed — every column required already exists.
- Real gap: new `insertDocumentPages`/`insertDocumentSections` repository functions; `persistFinding()` callers need to actually resolve+pass real FK ids instead of `null`.
- Effort: Low-Medium.

## Recommendation

Build: (1) PDF heading-heuristic + DOCX paragraph-style section detection feeding real
`document_page`/`document_section` persistence (Low-Medium effort, no schema change);
(2) rewrite `cag_review.py` around a worker-internal chunked review loop (Option A) with
a structured, cache-aware `LLMProvider` protocol — the single highest-leverage change,
since it fixes the "at most one finding" ceiling, gives real per-finding provenance, and
is what makes prompt caching (and acceptable cost at ~20-25 calls/thesis) possible;
(3) a genuinely deterministic rule layer (muletillas, long sentences, spelling, citation
cross-check, GT structure presence) with zero LLM calls, feeding the same tables via
`producer_type='deterministic_rule'`, shippable independently in parallel; (4) a real
`DeepSeekProvider` as a cheap triage pass ahead of Claude. This sequencing lets
lower-risk, independently valuable slices (deterministic rules, section-detection) ship
separately from the higher-risk chunked-LLM-review + provider-protocol change —
directly informing the `sdd-tasks` PR-chain split.

## Risks

- Breaking, deliberate test rewrites required in `test_cag_review.py`,
  `active-provider-resolution.test.mjs` (exact single-shot body `deepEqual` assertion),
  `live-review-integration.test.mjs` (`findings === 1` assertions).
- The Option A vs B design fork (worker-internal loop vs. N Node-driven calls) is
  unresolved and must be an explicit decision in propose/design, not a silent default.
- Cost/caching estimates and DeepSeek's automatic-caching claim are directional —
  re-verify against current Anthropic/DeepSeek docs at implementation time.
- New Python deps (spaCy Spanish model, pyspellchecker, rapidfuzz) need explicit
  `pyproject.toml` additions and container size consideration.
- Large multi-unit change — `sdd-tasks` should plan a chained-PR split per the 400-line
  budget guard, mirroring the sequencing above.

## Ready for Proposal

Yes — grounded in direct reads of every file the framing called out; one central design
fork flagged for explicit resolution in `sdd-propose`/`sdd-design`.
