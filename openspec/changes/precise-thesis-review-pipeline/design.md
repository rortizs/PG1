# Design: Precise Multi-Finding Thesis Review Pipeline

> Size note: this design deliberately exceeds the 800-word budget. The change spans a
> subprocess boundary, a schema migration, a breaking provider protocol, and a rewritten
> review loop; exact signatures/SQL/thresholds are the artifact's value. Prose is minimized
> to tables and code.

## Technical Approach

Worker owns all text processing (conversion, section detection, chunked LLM loop,
deterministic rules); Node owns all FK authority (`document_page` / `document_section` /
`finding`). `/internal/extract` gains `sections`; `/internal/review` becomes a chunked
multi-finding loop; a new `/internal/rules` endpoint runs zero-LLM checks. Node calls the
two review endpoints **independently**, so failure isolation (Non-Goal #3) is structural,
not conditional.

```
upload ─► /internal/extract ─► {pages[], sections[]}
             │                        │
             │      Node: insertDocumentPages + insertDocumentSections (real FK ids)
             │                        │
             ├──► /internal/rules ────┼──► rule findings ──┐  independent try/catch
             └──► /internal/review ───┴──► LLM findings ───┤  independent try/catch
                     (triage ► judgment, chunk loop)       │
                                                  persistFinding(real page/section ids)
```

## Architecture Decisions

### D1 — DOCX→PDF normalization (one canonical extraction path)

**Choice**: `_extract_docx()` converts to PDF via headless LibreOffice, then delegates to the
**unchanged** `_extract_pdf()`. `python-docx` is dropped from the extraction path (kept as a
dependency only if a future run-level formatting check needs it).
**Rejected**: `python-docx` paragraph-style sections with `is_page_uncertain=true` (rejected
by user decision #2); rendering with a Python PDF engine (no fidelity).
**Rationale**: one per-page code path, real page numbers for both formats, zero new page logic.

```python
SOFFICE_BINARY_ENV = "SOFFICE_BINARY"      # default "soffice"; verified at /opt/homebrew/bin/soffice
DOCX_CONVERSION_TIMEOUT_SECONDS = 120.0

class DocxConversionError(ExtractionError):
    """LibreOffice binary missing, conversion timeout, non-zero exit, or no PDF produced."""

def _convert_docx_to_pdf(data: bytes) -> bytes:
    binary = shutil.which(os.environ.get(SOFFICE_BINARY_ENV, "soffice"))
    if not binary:
        raise DocxConversionError(
            "LibreOffice headless binary not found (set SOFFICE_BINARY or install "
            "libreoffice) — DOCX cannot be converted to PDF and page-accurate "
            "provenance is required; refusing to degrade to section-only extraction."
        )
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "input.docx"      # FIXED name: the uploaded filename never reaches argv
        src.write_bytes(data)
        profile = Path(tmp) / "lo-profile"
        try:
            completed = subprocess.run(          # shell=False (list argv)
                [binary,
                 f"-env:UserInstallation=file://{profile}",   # per-call profile: a shared default
                 "--headless", "--norestore",                 # profile makes a concurrent soffice
                 "--convert-to", "pdf",                       # silently no-op
                 "--outdir", tmp, str(src)],
                capture_output=True, timeout=DOCX_CONVERSION_TIMEOUT_SECONDS, check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise DocxConversionError(f"LibreOffice conversion timed out after "
                                      f"{DOCX_CONVERSION_TIMEOUT_SECONDS}s") from exc
        out = Path(tmp) / "input.pdf"
        if completed.returncode != 0 or not out.exists():
            raise DocxConversionError(
                f"LibreOffice conversion failed (exit {completed.returncode}): "
                f"{completed.stderr.decode('utf-8', 'replace')[:500]}")
        return out.read_bytes()
```

Failure surface: `DocxConversionError` is an `ExtractionError` → `main.py` already maps it to
**HTTP 422** → `extractViaWorker` throws → the existing `createReviewOrchestrationProcessor`
catch writes `review_run.status='failed'` + `error_summary`. **Zero new failure plumbing** —
identical to today's `mvp-vertical-slice` convention.

`ExtractionResult.content_type` stays `RESOLVED_DOCX_CONTENT_TYPE` (`thesis_document.content_type`
CHECK requires the real upload type). Page provenance is recorded as
`extraction_method='pdf_text'`, `provenance_confidence=0.9`,
`metadata={"source_format":"docx","pagination_engine":"libreoffice"}`,
`is_page_number_uncertain=false`.

### D2 — Section-boundary detection

Runs in `extraction.py` over already-extracted per-page text; emits `ExtractedSection`.
Matching is accent-folded + case-folded + whitespace-collapsed, because the normative corpus
itself contains `CAPÌTULO`, `TEORICO`, `BIBLIOGRAFIA` (verified in
`data/academic-rules/tesis_guia_trabajo_gt.txt:598,643,684`).

| Pattern (per line, after strip) | Regex | `section_type` | conf |
|---|---|---|---|
| Chapter | `^cap[ií]tulo\s+([ivxlc]+\|\d+)\b` | `chapter` | 0.95 |
| GT keyword | `^(introduccion\|resumen\|marco teorico\|marco metodologico\|conclusiones\|recomendaciones\|glosario\|bibliografia\|referencias\|anexos?)\b` | `chapter`, or `references` for bibliografía/referencias, `appendix` for anexos | 0.9 |
| Numbered | `^(\d+(\.\d+)*)[.\s–-]+\S` (depth = dot count) | `section` (d=1) / `subsection` (d≥2) | 0.75 |
| ALL-CAPS line | `^[A-ZÁÉÍÓÚÑÜ0-9 ,:–-]{6,80}$`, ≤ 12 words, no terminal `.` | `unknown` | 0.55 |

Guards against false headings: line length ≤ 120 chars; line is not inside a detected
references block; a dotted-leader tail (`…{3,}` / `\.{4,}`) marks a **table-of-contents** line —
excluded from detection entirely (the corpus TOC pages are full of them).

Mapping to `document_section` columns: `title` = raw line, `normalized_title` = folded form,
`start_page_number` = page the heading was found on, `end_page_number` = page before the next
heading of equal-or-higher level (last section → last page), `parent_section_id` via the
level stack (chapter → section → subsection), `start_offset`/`end_offset` = character offsets
into `full_text`, `is_location_uncertain = confidence < 0.75`,
`metadata={"detector":"heading_heuristic","confidence":<c>,"pattern":"<row>"}`.
Zero headings detected → **no** `document_section` rows; chunking falls back to fixed windows.

### D3 — Persistence (`review-repository.mjs`)

```js
async insertDocumentPages({ reviewRunId, thesisDocumentId, pages, extractionMethod = "pdf_text",
                            provenanceConfidence = null, pageMetadata = {} })
  // one BEGIN/COMMIT; ordered INSERT ... RETURNING id per page
  // -> { ids: number[], idByPageNumber: Record<number, number> }

async insertDocumentSections({ reviewRunId, sections })
  // sections[] in DOCUMENT ORDER, each { index, parentIndex|null, sectionType, title,
  //   normalizedTitle, startPageNumber, endPageNumber, startOffset, endOffset,
  //   isLocationUncertain, metadata }
  // one BEGIN/COMMIT; parentIndex resolves against already-inserted idByIndex — safe because
  // a parent heading ALWAYS precedes its child in document order (level-stack invariant)
  // -> { ids: number[], idByIndex: Record<number, number> }
```

Also modified: `updateReviewRunStatus` gains `metadata` (same `COALESCE` pattern) for
partial-failure recording; `persistFinding` gains optional `finding.metadata` and
`finding.ruleId` (both columns already exist). `persistFinding`'s `documentPageId` /
`documentSectionId` are wired in `review-orchestrator.mjs` from
`idByPageNumber[f.page_number]` and `idByIndex[f.section_index]`.

**Partial-failure semantics**: LLM path fails but rules succeeded (or vice versa) →
`status='completed'`, `error_summary=<failed path message>`,
`metadata.partial_failure={llm|rules: message}`. Both paths fail, or extraction fails →
`status='failed'` (today's behavior, unchanged).

### D4 — Chunked review loop (`cag_review.py`)

| Constant | Value | Why |
|---|---|---|
| `MAX_CHUNK_PAGES` | 8 | ~20-25 chunks for 150-200pp (proposal cost model) |
| `MAX_CHUNK_CHARS` | 24_000 | hard split for dense pages |
| `CONTEXT_TAIL_CHARS` | 800 | previous-chunk tail, labelled `CONTEXT ONLY — do not report findings from this block` |
| `MIN_LLM_CONFIDENCE` | **0.75** | user decision #5, false-positive-averse |
| `GROUNDING_FUZZ_MIN` | **95** | `rapidfuzz.fuzz.partial_ratio` |
| `DEDUP_MIN` | **92** | `rapidfuzz.fuzz.token_set_ratio` |

Chunking: one chunk per `document_section` when sections exist; a section longer than
`MAX_CHUNK_PAGES` is split into sub-chunks carrying the same `section_index`; **zero sections →
fixed 8-page windows with `section_index=null`**. Loop shape:

```
for chunk in chunks:
    if triage_provider and not triage_says_suspect(chunk):   # error -> suspect=True (fail OPEN)
        continue
    raw = judgment_provider.complete(system_blocks=[SYSTEM, CORPUS(cacheable)], user_text=chunk.text)
    for f in parse_findings(raw):            # {"findings": [...]} — [] means clean, NOT an error
        if f.confidence < MIN_LLM_CONFIDENCE: drop(reason="below_confidence"); continue
        if not grounded(f.evidence_text, chunk.source_text): drop(reason="ungrounded"); continue
        accepted.append(f)
return dedup(accepted) sorted by (severity desc, page asc)   # NO CAP
```

`grounded()`: NFC-normalize + collapse whitespace + casefold, exact substring first, else
`partial_ratio >= 95`. Below that the finding is **dropped**, never persisted (Non-Goal #1).
A malformed/non-JSON provider response still raises `CagReviewError` (unchanged) — never a
silent "clean" result. Drop counts return as `stats` and land in `review_run.metadata`.

**Dedup**: same `finding_type` + `token_set_ratio(evidence_a, evidence_b) >= 92` + chunk
distance ≤ 1 → **drop** the lower-confidence one (do not merge into multi-evidence: merging
inflates apparent coverage), recording `metadata.duplicate_of_pages=[...]` on the survivor.

### D5 — Cache-aware provider protocol (breaking)

```python
@dataclass(frozen=True)
class PromptBlock:
    text: str
    cacheable: bool = False

@dataclass(frozen=True)
class CompletionResult:
    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None      # success criterion: > 0 after chunk #1
    cache_write_tokens: int | None = None

@runtime_checkable
class LLMProvider(Protocol):
    def complete(self, *, system_blocks: list[PromptBlock], user_text: str,
                 max_tokens: int = 2048) -> CompletionResult: ...
```

`generate()` is removed (deliberate break; rollback = revert the slice, per the proposal).

| Impl | Mapping |
|---|---|
| `AnthropicProvider` | `system=[{"type":"text","text":b.text, **({"cache_control":{"type":"ephemeral","ttl":CACHE_TTL}} if b.cacheable else {})} …]`, `messages=[{"role":"user","content":user_text}]`; reads `response.usage.cache_read_input_tokens` / `cache_creation_input_tokens` |
| `DeepSeekProvider` (new, real) | cacheable blocks concatenated **first, in stable order**, into one `system` message — DeepSeek caches automatically on exact prefix, so ordering *is* the cache key |
| `GroqProvider` | stays `UnimplementedProvider`; `complete()` raises `ProviderNotImplementedError` |

`CACHE_TTL = os.environ.get("ANTHROPIC_CACHE_TTL", "1h")`. `"1h"` currently requires the
`anthropic-beta: extended-cache-ttl-2025-04-11` header and carries a 2× write premium (5m ≈
1.25×, reads ≈ 0.1× base). **Cross-review-run cache reuse is only possible with the 1h TTL** —
5m expires between runs. Setting the env to `5m` omits both the `ttl` key and the beta header.
Exact header/field names MUST be re-verified against current Anthropic docs at implementation
(proposal risk row); caching is an optimization, never a correctness dependency.

### D6 — Real `DeepSeekProvider` (`providers/deepseek_provider.py`)

`httpx` only (no `openai` SDK), mirroring `AnthropicProvider` exactly: lazy key
(`self._api_key or os.environ.get("DEEPSEEK_API_KEY")`), errors raised inside `complete()`.
`POST {DEEPSEEK_BASE_URL:-https://api.deepseek.com}/chat/completions`,
`Authorization: Bearer <key>`, body
`{model: model or "deepseek-chat", messages:[system,user], max_tokens, temperature: 0, stream: false}`;
text from `choices[0].message.content`; `usage.prompt_cache_hit_tokens` →
`cache_read_tokens`, `usage.prompt_cache_miss_tokens` → `cache_write_tokens`. New
`DeepSeekProviderConfigError` / `DeepSeekProviderUpstreamError` (both `LLMProviderError`), so
`main.py`'s existing except-ladder needs one added branch mapping config errors to 500.

### D7 — Role-based provider assignment

**Correction to the framing**: `UNIQUE (role) WHERE is_active` **does** express
"one active row per role" — a partial unique index keys on `role` among only the active rows,
so `('judgment', active)` and `('triage', active)` coexist while a second active `judgment`
is rejected. Today's `UNIQUE (is_active) WHERE is_active` keys on a constant-true column,
which is what makes it globally singular.

`0004_llm_provider_role.sql`:
```sql
-- UP
ALTER TABLE llm_provider_config
  ADD COLUMN role TEXT NOT NULL DEFAULT 'judgment'
    CONSTRAINT llm_provider_config_role_check CHECK (role IN ('judgment', 'triage'));
DROP INDEX uq_llm_provider_config_one_active;
CREATE UNIQUE INDEX uq_llm_provider_config_one_active_per_role
  ON llm_provider_config (role) WHERE is_active;
CREATE INDEX idx_llm_provider_config_role ON llm_provider_config(role);
-- DOWN
DROP INDEX IF EXISTS uq_llm_provider_config_one_active_per_role;
DROP INDEX IF EXISTS idx_llm_provider_config_role;
CREATE UNIQUE INDEX uq_llm_provider_config_one_active ON llm_provider_config (is_active) WHERE is_active;
ALTER TABLE llm_provider_config DROP COLUMN IF EXISTS role;
```
DOWN fails loudly if two roles are simultaneously active — documented, correct, and
recoverable by deactivating the triage row first. Existing rows default to `judgment`, so
today's single active provider keeps working byte-identically.

`0005_review_run_triage_provenance.sql`: adds nullable `triage_provider_name`
(same CHECK-list as `llm_provider_name`) + `triage_model_id` to `review_run`.
`llm_provider_name`/`llm_model_id` keep their meaning = the **judgment** provider.

| Layer | Change | Back-compat guarantee |
|---|---|---|
| `provider-config-repository.mjs` | `getActiveProvider(role = "judgment")` → `WHERE is_active AND role = $1`; `activate(id)` reads the target's role first, then `UPDATE … is_active=false WHERE is_active AND role = $role` inside the existing single transaction; `toMaskedView` adds `role` | default arg = today's behavior |
| `admin-contract.mjs` | create accepts optional `role` (default `'judgment'`, validated against `['judgment','triage']`); **PATCH rejects `role`** (immutable — prevents moving an active row into an already-occupied role); activate unchanged (role comes from the row) | omitted `role` ⇒ `judgment` |
| `live-review-pipeline.mjs` | `getActiveProvider("judgment")` — missing ⇒ existing `"no active LLM provider configured"` error → real `failed` status; `getActiveProvider("triage")` — missing ⇒ `null`, loop simply skips triage | `triage` optional by construction |
| `admin-providers-view.ts` / `-page.ts` | `role` on `AdminProviderRow` + `CreateProviderPayload`; `<select formControlName="role">` (judgment/triage) shown only on create; new "Role" table column; `buildUpdateProviderPayload` never emits `role` | |

### D8 — Deterministic rule engine (`services/worker/app/rules/`)

```
rules/__init__.py        run_rules(pages, sections) -> list[RuleFinding]   (imports NO provider module)
rules/base.py            RuleFinding dataclass + shared normalization helpers
rules/segmentation.py    sentences(text) — pysbd(language="es")
rules/filler_words.py    lexicon regex   -> writing_style, conf 0.90
rules/long_sentences.py  > 40 words      -> writing_style, conf 0.85
rules/spelling.py        pyspellchecker  -> writing_style, conf 0.75 (gated, see below)
rules/citations.py       in-text vs reference list -> apa, conf 0.80
rules/gt_structure.py    expected-vs-detected sections -> gt, conf 0.85
```

**Sentence segmentation**: `pysbd` (`language="es"`), pure-Python, no model download, ~200 KB.
**Rejected**: spaCy + `es_core_news_sm` (~45 MB with numpy) — its only advantage is POS
tagging, and every POS-dependent check (grammar, agreement, reliable passive/gerund
detection) is already deferred on technical grounds. Paying 45 MB for a sentencizer is
disproportionate. Fallback if `pysbd`'s Spanish quality disappoints in RED tests: a
hand-rolled abbreviation-aware splitter in `segmentation.py` — the interface hides the choice.

**Spelling conservatism gate** (false-positive-averse): flag a token only when it fails the
dictionary AND is lowercase AND `len >= 4` AND is not an acronym AND contains no digits AND is
not inside a detected reference/citation span. Below these, silent.

**GT structure**: expected set grounded in the corpus —
`introduccion, marco teorico, marco metodologico, conclusiones, recomendaciones, bibliografia|referencias, anexos` (+ `capitulo N`), verified in `tesis_guia_trabajo_gt.txt:598-685`,
`plantilla_sugerida_trabajo_graduacion.txt:39-106`, `ejemplo_para_guia.txt:202`. Missing →
`finding_type='gt'`, evidence = the document's detected section list (always literal text,
never fabricated). Skipped entirely when zero sections were detected (no evidence ⇒ no finding).

All rule findings: `producer_type='deterministic_rule'`, `producer_id='rules@v1'`,
`rule_id='<module>.<check>'`, `MIN_RULE_CONFIDENCE = 0.70`.

### D9 — Failure isolation

`/internal/rules` imports nothing from `app/providers/` — it is structurally incapable of an
LLM call. Node calls the two endpoints in separate `try/catch` blocks and persists each
result set separately, so neither path can block or corrupt the other (Non-Goal #3).

## File Changes

| File | Action | Description |
|---|---|---|
| `services/worker/app/extraction.py` | Modify | DOCX→PDF conversion, `DocxConversionError`, `ExtractedSection` + heading detection |
| `services/worker/app/cag_review.py` | Rewrite | chunk loop, multi-finding, grounding + confidence filters, dedup, triage hook |
| `services/worker/app/providers/llm_provider.py` | Modify | `PromptBlock` / `CompletionResult` / `complete()` |
| `services/worker/app/providers/anthropic_provider.py` | Modify | system blocks + `cache_control` + usage extraction |
| `services/worker/app/providers/deepseek_provider.py` | Create | real `httpx` implementation |
| `services/worker/app/providers/unimplemented_provider.py` | Modify | `generate` → `complete`; Groq stays a stub; DeepSeek subclass removed |
| `services/worker/app/rules/*.py` | Create | 7 modules per D8 |
| `services/worker/app/main.py` | Modify | new `/internal/review` contract, new `/internal/rules`, DeepSeek error branch |
| `services/worker/pyproject.toml` | Modify | `pysbd>=0.3.4`, `pyspellchecker>=0.8`, `rapidfuzz>=3.9` |
| `apps/api/src/db/migrations/0004_llm_provider_role.sql` | Create | role column + per-role partial unique index |
| `apps/api/src/db/migrations/0005_review_run_triage_provenance.sql` | Create | triage provenance columns |
| `apps/api/src/db/review-repository.mjs` | Modify | `insertDocumentPages`, `insertDocumentSections`, metadata params |
| `apps/api/src/db/provider-config-repository.mjs` | Modify | role-scoped `getActiveProvider` / `activate` / masked view |
| `apps/api/src/admin-contract.mjs` | Modify | `role` on create; rejected on PATCH |
| `apps/api/src/jobs/review-orchestrator.mjs` | Modify | pages/sections persistence, two independent calls, multi-finding loop, 15-min timeout |
| `apps/api/src/live-review-pipeline.mjs` | Modify | per-role resolution, triage forwarding, dual provenance |
| `apps/web/src/app/admin/admin-providers-view.ts`, `-page.ts` | Modify | role field/column/select |

## Interfaces / Contracts

```jsonc
// POST /internal/review  (worker timeout: DEFAULT_WORKER_REVIEW_TIMEOUT_MS = 900_000)
{ "pages":   [{ "page_number": 1, "text": "..." }],
  "sections":[{ "index": 0, "title": "CAPÍTULO 1", "section_type": "chapter",
                "start_page_number": 1, "end_page_number": 12, "is_location_uncertain": false }],
  "judgment_provider": { "provider_name": "claude", "api_key": "...", "model_id": "..." },
  "triage_provider":   null }
// -> { "findings": [ { ..., "page_number": 7, "section_index": 0 } ],
//      "stats": { "chunks": 23, "triage_skipped": 9, "dropped_low_confidence": 4,
//                 "dropped_ungrounded": 1, "dropped_duplicate": 3,
//                 "cache_read_tokens": 184320, "cache_write_tokens": 18240 } }

// POST /internal/rules   -> { "findings": [...] }   // { pages, sections } only; zero LLM
```

## Testing Strategy (strict TDD — every row is a RED test first)

| Layer | What | Approach |
|---|---|---|
| Unit (py) | conversion failure paths, heading regex table, chunk planner, grounding/confidence/dedup filters, each rule module, block→`cache_control` mapping, DeepSeek request/response shape | `unittest` + fakes; `SOFFICE_BINARY=/nonexistent` and a `false`-like stub binary for the subprocess rows |
| Unit (js/ts) | `insertDocumentPages`/`insertDocumentSections` (incl. parent FK), role-scoped `getActiveProvider`/`activate`, admin `role` validation, Angular view-model payloads | `node:test` + real Postgres for repo tests (existing pattern) |
| Integration | per-role partial unique index rejects a second active `judgment` and accepts an active `triage`; LLM-path failure still persists rule findings (and inverse) | real Postgres + fake worker |
| E2E | full run yields many findings with real `document_page_id`/`document_section_id`; `cache_read_tokens > 0` after chunk #1 | live-review integration suite |

### Deliberate test rework (RED-first, same work unit)

| Test | Why it breaks | Rework |
|---|---|---|
| `services/worker/tests/test_cag_review.py` | `len(received_prompts) == 1`, `CagFinding \| None`, `FakeLLMProvider.generate` | fake implements `complete()`; assert N chunk calls, list return, corpus block present with `cacheable=True` |
| `apps/api/tests/active-provider-resolution.test.mjs` | exact `deepEqual` on `{thesis_text, provider_name, api_key, model_id}` | assert new body shape + `judgment_provider`; add a triage-role scenario |
| `apps/api/tests/live-review-integration.test.mjs` | `summary.findings === 1`, `items.length === 1` | assert `>= 2` findings with non-null page/section ids; keep the zero-findings and configuration-error scenarios byte-identical |
| `apps/api/tests/review-orchestrator.test.mjs` (~L231-264) | `deepEqual(getLastBody(), { thesis_text: … })` on both the with- and without-provider paths | rewrite against the new body; the legacy `thesis_text`-only shape is intentionally removed |

**Untouched**: `contract.test.mjs`, `smoke.test.mjs`, `upload-storage.test.mjs`,
`postgres-unreachable.test.mjs`, `review-repository.test.mjs` (its `findings.length === 1` is a
direct single-`persistFinding` assertion, still valid), and every admin CRUD test except the
new `role` field additions.

## Threat Matrix

| Boundary | Adversarial cases | Applicability | Design response | Planned RED tests |
|---|---|---|---|---|
| Documentation-like paths | executable-looking uploads (`.docx` that is a ZIP bomb / renamed script) | **Applicable** | Bytes are only ever written to a temp file and passed as a *data* argument to `soffice`; never executed, never sourced; existing content-type/extension gate unchanged | renamed-executable upload → `CorruptFileError`/`DocxConversionError`, never execution |
| Git repository selection | — | **N/A** — no VCS automation in this change | — | — |
| Commit state | — | **N/A** — no VCS automation | — | — |
| Push state | — | **N/A** — no VCS automation | — | — |
| PR commands | — | **N/A** — no PR automation | — | — |
| **Subprocess argument composition** (added row) | filename injection (`"; rm -rf /"`, `--outdir` lookalikes, leading `-`), path traversal, unbounded runtime, concurrent-instance no-op, orphaned temp files | **Applicable** | `shell=False` list argv; the uploaded filename NEVER reaches argv (fixed `input.docx` inside a fresh `TemporaryDirectory`); per-call `-env:UserInstallation` profile; `timeout=120s`; `TemporaryDirectory` guarantees cleanup on every exit path | (1) hostile filename → argv contains only `input.docx`; (2) missing binary → `DocxConversionError` + `failed` run; (3) timeout → `DocxConversionError`, no hang; (4) non-zero exit → `DocxConversionError`; (5) temp dir removed on both success and failure |
| **Credential handling** (added row) | triage/judgment keys in logs or error text | **Applicable** | Keys travel only in the internal API→worker body (existing trust boundary); never logged; `error_summary` assertions extended to the triage key | `error_summary` must not match the triage api key (mirrors the existing judgment-key assertion) |

## Migration / Rollout

Two forward-only migrations (`0004`, `0005`) with working DOWNs (0004's DOWN requires no two
roles active simultaneously). `document_page`/`document_section` need no migration. Chained PR
slices, each independently revertable: **(1)** section detection + page/section persistence ·
**(2)** deterministic rules + `/internal/rules` · **(3)** DOCX→PDF conversion · **(4)** chunked
LLM loop + cache-aware protocol · **(5)** role-based provider assignment (0004/0005 + admin +
UI) · **(6)** real DeepSeek triage. Slices 1-3 ship value with the current single-call LLM path
still intact; the breaking protocol change is isolated to slice 4.

## Open Questions

- [ ] Anthropic 1h-TTL beta header name and current write-premium multiplier — re-verify against
      live docs at implementation (design falls back to the 5m default, correctness-neutral).
- [ ] `pysbd` Spanish segmentation quality on real thesis text — RED tests decide; documented
      fallback is a hand-rolled abbreviation-aware splitter behind the same interface.
- [ ] LibreOffice pagination may differ from Word's own rendering; pages are real and citable
      but derived from the converted PDF. Recorded as `provenance_confidence=0.9` +
      `metadata.pagination_engine`. Confirm this is acceptable to the reviewer workflow.
