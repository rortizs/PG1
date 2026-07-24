# Design: MVP Vertical Slice (Upload → CAG Review → Persist → UI)

## Technical Approach

Wrap the existing framework-light services in real transport without rewriting logic. NestJS becomes a thin HTTP layer that delegates to the existing pure `handleApiRequest`/services; Angular (standalone) provides upload + results pages; FastAPI hosts extraction + a Claude CAG module behind a provider abstraction; Postgres+pgvector runs in Docker with migration `0001` executed live by a plain `pg` runner. Redis/BullMQ is replaced by an **inline queue adapter** implementing the same `add()` seam. Every existing service keeps its signature so 36/37 tests stay green; only `apps/web/tests/smoke.test.mjs` is a conscious update.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|----------|--------|----------|-----------|
| 1 | NestJS wiring | `@nestjs/core|common|platform-express` ^11; real `main.ts` `app.listen()`; `@Module`/`@Controller` decorators on **existing** class names; controllers delegate to existing `handleApiRequest`/services | Rewrite handlers in Nest | Preserves `contract.test.mjs` seam assertions + pure-handler unit tests; additive transport |
| 2 | Angular | Standalone components, signals, `provideHttpClient`, application builder; two routes `/upload`, `/runs/:id` | NgModules | Current Angular best practice; smallest real scaffold |
| 3 | Worker | Real `FastAPI()`; keep `WORKER_SERVICE_NAME`; POST `/internal/extract` + `/internal/review` | Node-side extraction | Matches accepted worker boundary; keeps `test_smoke.py` green |
| 4 | Extraction lib | `pypdf` (BSD) for PDF, `python-docx` (MIT) for DOCX; page-level text, no OCR | pdfplumber/OCR | Pure-python, license-safe, simple for slice |
| 5 | LLM provider abstraction | `LLMProvider` protocol in `services/worker/app/providers/`; `AnthropicProvider` (Claude) only wired | Hardcode Anthropic in caller | DeepSeek/Groq drop in later with no caller change |
| 6 | CAG module | Build one prompt = full 4-file corpus + extracted excerpt; parse structured JSON → 0-or-1 finding w/ evidence text + provenance | pgvector RAG | Corpus ~1,300 lines fits one call; no embeddings needed |
| 7 | Migration runner | Plain `pg` client splitting `-- UP`/`-- DOWN`, executing `0001.sql`; `apps/api/src/db/migrate.mjs` | ORM (Prisma/TypeORM) | No ORM decision yet; runs existing SQL unchanged |
| 8 | DB image | `pgvector/pgvector:pg16`, compose service `db` only; api/worker run on host | Full compose of all services | Extension preinstalled; minimal footprint |
| 9 | Persistence | New `apps/api/src/db/review-repository.mjs` (`pg`) writes thesis_document→review_run→evidence_snippet→finding→finding_evidence; seed `normative_source` rows for the 4 corpus files | Persist via lifecycle Map | Honors schema guardrails + "cites approved source" |
| 10 | Sync seam | `createInlineReviewQueue({ processor })` — same `add()` API runs processor inline; lifecycle service + tests untouched | Delete queue/edit lifecycle | Preserves BullMQ swap seam |
| 11 | Object storage | Add `createFilesystemObjectStorage` adapter (same interface); keep memory adapter | Replace memory / S3 now | Real bytes on disk; memory tests stay green |

## Data Flow

    Angular /upload ──POST /api/v1/thesis-documents──▶ NestJS ──▶ upload-service ──▶ filesystem storage
                                                         │
                                                         ▼ POST .../review-runs (202)
                                    lifecycle.startReviewRun ──add()──▶ inlineQueue.processor
                                                         │
        ┌────────────────────────────────────────────────┼───────────────────────────────┐
        ▼                          ▼                       ▼                                ▼
   POST /internal/extract    POST /internal/review    review-repository (pg)          transitions
   (pypdf/python-docx)  ──▶  (Claude CAG → finding) ──▶ evidence+finding+join ──▶ Postgres
                                                                                          │
    Angular /runs/:id ◀──GET .../findings (live DB read)◀── NestJS ◀────────────────────┘

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `apps/api/src/main.ts` | Modify | Real Nest bootstrap; keep `bootstrapApi`/`NestJS-compatible` comment |
| `apps/api/src/app.module.ts`, `*.controller.ts` | Modify | Add `@Module`/`@Controller`/`@Get`/`@Post`; keep class names; delegate to existing services |
| `apps/api/src/db/migrate.mjs` | Create | `pg` runner for `0001.sql` UP/DOWN |
| `apps/api/src/db/review-repository.mjs` | Create | `pg`-backed canonical writes + corpus seed |
| `apps/api/src/jobs/inline-review-queue.mjs` | Create | Sync `add()` seam + orchestration processor |
| `apps/api/src/storage/object-storage.mjs` | Modify | Add filesystem adapter (additive) |
| `apps/api/package.json` | Modify | +`@nestjs/*`, `pg` |
| `services/worker/app/main.py` | Modify | Real `FastAPI()` + `/internal/extract`, `/internal/review` |
| `services/worker/app/providers/`, `cag_review.py` | Create | Provider protocol + Anthropic impl + CAG prompt/parse |
| `services/worker/pyproject.toml` | Modify | +`fastapi`, `uvicorn`, `anthropic`, `pypdf`, `python-docx`, `httpx`, `pytest-asyncio` |
| `apps/web/**` | Modify | Angular standalone scaffold (upload + results) |
| `infra/docker-compose.yml` | Create | `pgvector/pgvector:pg16` service `db` |
| `.env.example` | **Manual** | See below (Write/Bash blocked from `.env*`) |

## Interfaces / Contracts

`.env.example` expected content (create manually):

    DATABASE_URL=postgres://pg1:pg1@localhost:5432/pg1
    ANTHROPIC_API_KEY=sk-ant-...
    WORKER_BASE_URL=http://localhost:8000

Worker `/internal/review` returns: `{ finding: { finding_type:"rag_review", severity, confidence, title, explanation, recommendation, evidence_text, page_number|null, section_title|null, normative_source_ref, producer_type:"controlled_rag", producer_id:"claude-<model>" } | null }`. Null = no evidence → no finding persisted.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | Provider abstraction, CAG JSON parse, filesystem storage, migrate split | pytest / node:test with fakes; no live Claude |
| Integration | Migration runs on live pg; repository writes satisfy guardrails; inline processor end-to-end | Dockerized pg; mocked worker/Claude |
| E2E | Upload→finding visible | Angular component test + one scripted run |

**TDD implications (STRICT):** (1) `apps/web/tests/smoke.test.mjs` **must be consciously rewritten RED** — Angular scaffold removes `Pg1AdminApp`. (2) CAG parse must be tested with a **fake provider** (no key at design time); Anthropic call isolated behind the protocol. (3) Live-migration + repository tests need Docker pg — gate as integration tier. (4) 36 existing tests must stay green unmodified: `schema-migration`(6), `upload-storage`(8), `review-run-lifecycle`(10), `contract`(13→verify seam names + `api-contract.mjs` pure paths kept), api `smoke`, worker `test_smoke`.

## Threat Matrix

| Boundary | Applicability | Note |
|----------|---------------|------|
| Documentation-like paths | N/A | No exec-file classification |
| Git repo selection / Commit / Push / PR commands | N/A | No VCS/PR automation in this slice |

Process-integration surface not in matrix rows: bind worker to localhost only (no external SSRF target); pass `DATABASE_URL`/`ANTHROPIC_API_KEY` as server-side env only (never to browser); apply timeout on Claude + worker HTTP calls. Carry as apply-phase guards, not RED tests.

## Migration / Rollout

Migration `0001` executed live first (PR A) before app wiring. Rollback: `-- DOWN` drops; remove compose + wiring PRs; accepted `mvp-academic-review-core` design untouched.

## Open Questions

- [ ] Claude model id (e.g. `claude-sonnet-4`) — user/env decides at runtime; not blocking design.
- [ ] Corpus→`normative_source` seed identity (one row per file vs. one aggregate) — recommend one row per file.
