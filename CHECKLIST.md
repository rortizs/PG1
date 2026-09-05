# PG1 Project Checklist

This checklist is the root-level operational view. It replaces the stale planning list in `HISTORY.md#Próximos Pasos` as the day-to-day source for what is done, what is partial, and what comes next.

Last updated: 2026-09-04

## Current next action

- [ ] Continue `precise-thesis-review-pipeline` Work Unit 9: role-based provider assignment.
  - WU8 implementation and verification are complete.
  - Keep WU9 scoped to provider-role migrations, repository/API wiring, and admin UI role selection only; real DeepSeek triage remains WU10.

## Recently completed

- [x] Complete `precise-thesis-review-pipeline` Work Unit 8: chunked multi-finding review loop + `/internal/review` contract.
  - Evidence: chunk planning, multi-finding filtering/dedup/stats, structured worker request/response, API persistence of every returned finding, worker **114 tests OK**, API **151 pass / 0 fail** with `DATABASE_URL=postgres://pg1:pg1@localhost:5432/pg1`.
- [x] Complete `precise-thesis-review-pipeline` Work Unit 7: cache-aware provider protocol.
  - Evidence: `PromptBlock`/`CompletionResult` protocol, Anthropic cache-control + usage mapping, default/1h TTL tests, and `cag_review.py` single-call `complete()` adaptation passed.
- [x] Complete `precise-thesis-review-pipeline` Work Unit 6: DOCX-to-PDF conversion.
  - Evidence: safe LibreOffice subprocess conversion, shared PDF extraction behavior, failure handling, cleanup tests, and real local `soffice` smoke extraction passed.
- [x] Archive `reviewer-authentication` SDD change.
  - Evidence: archived with PASS, 221/221 tests, 0 critical findings.
  - Artifact: `openspec/changes/archive/2026-09-03-reviewer-authentication/`.
- [x] Seed and verify the first local reviewer account.
  - Local-only evidence: `apps/api/src/db/seed-reviewer.mjs` ran against `localhost:55432`; real HTTP login succeeded.
  - Deployment note: every real deployment target still needs its own seeded reviewer account and separately generated password.
- [x] Apply real CSS to the Angular screens using the Scholarly Schematic direction.
- [x] Fix the student review detail page to load real review-board-card API data.
- [x] Add the first CI workflow for the project.
- [x] Archive `thesis-normative-governance`.

## Active OpenSpec changes

| Change | Status | Next |
| --- | --- | --- |
| `precise-thesis-review-pipeline` | Active; Work Units 1–8 complete, 9–10 pending | Continue Work Unit 9: role-based provider assignment |
| `mvp-academic-review-core` | Active legacy backlog; Work Units 1–5 complete, 6–16 pending | Reconcile overlap before using it as the driving backlog |

## Root legacy checklist reconciliation

| `HISTORY.md#Próximos Pasos` item | Current status |
| --- | --- |
| Crear `AGENTS.md` | Present in the repository root |
| Crear `README.md` | Done |
| Definir estructura monorepo | Done |
| Implementar parser PDF/DOCX | Done for current extraction scope; DOCX now converts through LibreOffice into the canonical PDF per-page path |
| Crear motor de validación GT + APA | Partial; deterministic rules exist, broader APA/GT governance remains pending |
| Integrar OneDrive | Pending / out of current scope |
| Integrar comentarios automáticos DOCX | Pending / out of current scope |
| Crear sistema de embeddings | Mostly done via pgvector/RAG, but controlled RAG backlog remains |
| Implementar RAG | Done for current MVP path; still has precision/backlog improvements |
| Multiusuario / panel docente / dashboard estadístico / historial | Low-priority backlog |

## Environment notes

- Local Postgres is currently reachable on `localhost:5432`; older archived runs may mention `localhost:55432` from a previous local port mapping.
- Do not sweep unrelated local noise into commits: `.pi/settings.json`, `.pi-lens` caches, `.firecrawl/`, `.openclaw/`, `.windsurf/`, `AGENTS.md`, and `SOUL.md` may appear in `git status`.
- Keep work-unit commits narrow. Do not batch several OpenSpec work units before committing unless explicitly accepted.
