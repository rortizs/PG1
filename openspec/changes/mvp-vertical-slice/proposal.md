# Proposal: MVP Vertical Slice (Upload → CAG Review → Persist → UI)

## Intent

Prove the whole path runs with something real. Deliberately jump ahead of the sequential `mvp-academic-review-core` work-unit order to ship one honest end-to-end flow: upload a thesis file through a real Angular page → real (minimal) extraction → one real Claude-backed CAG review check against `data/academic-rules/` → persist the finding to a real PostgreSQL (Docker) → view it in the UI. This is delivery reordering, not redesign: the accepted `mvp-academic-review-core/design.md` (pgvector/BullMQ/Redis) stays the target.

## Scope

### In Scope
- Real NestJS server (`app.listen()`, real `@Module`/`@Controller`/DI) wrapping existing services.
- Real Angular upload + results page (real CLI scaffold).
- Real FastAPI worker (replace dict with `FastAPI()`).
- Postgres+pgvector via `docker-compose`, executing migration `0001_schema_baseline.sql` **live** for the first time.
- One working CAG-based finding, end to end, carrying real evidence/provenance.
- Claude as the only wired LLM provider; `.env.example` for `DATABASE_URL` + `ANTHROPIC_API_KEY`.

### Out of Scope (deliberately stubbed / deferred)
- Redis/BullMQ → **synchronous processing** this slice.
- Full rule engine (GT/APA/congruence) → one review check only.
- DOCX/XLSX reports, agentic RAG, multi-provider routing, OCR, pgvector-backed RAG embeddings.

## Deviation Sign-off
Bypassing Redis/BullMQ for synchronous processing diverges from the accepted `design.md` queue architecture. This is a deliberate, reversible, temporary shortcut. `review-run-lifecycle.mjs` and `review-queue.mjs` stay as the seam where real BullMQ swaps in later — **do not delete them**.

## Relationship to `mvp-academic-review-core`
Not scrapping it. Work Units 1–5 code (`upload-service.mjs`, `object-storage.mjs`, `review-run-lifecycle.mjs`, `review-queue.mjs`, `0001_schema_baseline.sql`) is reused/wrapped by real framework wiring. After this slice proves the path, the original change resumes at remaining units (worker parser, rule engine, controlled RAG with real embeddings, reports).

## Non-Goals
- Do **not** silently reintroduce OpenAI.
- Do **not** drop the "no evidence = rejected finding" rule. The one CAG finding must carry real evidence text, page/section, finding type, and source provenance — never an invented summary.

## Capabilities

### New Capabilities
- `vertical-slice-cag-review`: synchronous end-to-end upload→CAG-check→persist→view producing one evidence-grounded finding via Claude.

### Modified Capabilities
- None (existing `mvp-academic-review-core` spec domains — `document-review-core`, `rag-review` — are not respec'd; this slice is a delivery cut, spec'd separately).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/api/src/main.ts`, `app.module.ts`, `*.controller.ts` | Modified | Real NestJS transport over existing services |
| `apps/web/*` | Modified | Real Angular CLI scaffold (upload + results) |
| `services/worker/app/main.py` | Modified | Real `FastAPI()` |
| `apps/api/src/db/migrations/0001_schema_baseline.sql` | Reused | First live execution |
| `infra/docker-compose.yml`, `.env.example` | New | Postgres+pgvector; env contract |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Angular real-vs-stub gap causes overrun | High | Isolate scaffold to own PR |
| First live migration surfaces issues static tests missed | Med | Run migration in its own PR before app wiring |
| Empty `pnpm-lock.yaml` → large first lockfile diff | High | Isolate `pnpm install` to own PR |
| Sync shortcut leaks past the seam | Med | Keep queue abstractions; no logic deletion |
| No `ANTHROPIC_API_KEY` present | High | User supplies local `.env` before design commits CAG call |

## Rollback Plan
Remove `openspec/changes/mvp-vertical-slice/`; revert wiring PRs. Existing Work Units 1–5 stubs and accepted `design.md` are untouched, so `mvp-academic-review-core` resumes unaffected.

## Dependencies
- User-supplied `ANTHROPIC_API_KEY` in local `.env` (not yet present).
- `git init` (repo has no `.git` yet) before PR-chain delivery.
- Docker + Compose (verified available).

## Delivery / TDD Note
STRICT TDD is active (runner: `pnpm test`). The eventual tasks/apply phases MUST follow RED→GREEN→TRIANGULATE→REFACTOR per work unit. This exceeds one ≤400-line PR — expect the explore-suggested chain (A: compose+migration+env, B: NestJS+Angular, C: extraction+CAG+persist, D: findings view).

## Success Criteria
- [ ] One uploaded file flows end-to-end to a persisted, UI-visible finding.
- [ ] Finding carries real evidence text + section/page + type + Claude/source provenance.
- [ ] Migration `0001` executes live against Dockerized Postgres+pgvector.
- [ ] Redis/BullMQ seam preserved (queue abstractions intact, not deleted).
- [ ] Claude is the only wired provider; no OpenAI reintroduced.
