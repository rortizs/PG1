# Implementation Tasks — MVP Academic Review Core

## 2026-09-13 Reconciliation

This change predates several completed PG1 changes. Do **not** apply the original pending Work Units 6–12 as written; much of that work was delivered by later, narrower OpenSpec changes and merged into `main`.

The current executable backlog for this change starts with **Work Unit R1a — Markdown report contract core** below. A prior attempt to implement all Markdown reporting in one R1 slice exceeded the 400-line review budget; the report MVP is now split into smaller slices.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Current next slice | R1a Markdown report contract core |
| Estimated changed lines | R1a: 150–250; R1b: 150–250; R1c: 150–250; R2/R3 only if needed |
| 400-line budget risk | Low per slice if boundaries are respected |
| Chained PRs recommended | No for R1a alone; split remains mandatory if a slice approaches 400 changed lines |
| Suggested split | R1a view-model/renderer tests → R1b repository/artifact persistence → R1c HTTP route integration |
| Delivery strategy | ask-on-risk |
| Chain strategy | N/A unless an individual slice exceeds the review budget |

Decision needed before apply: No, if the next apply implements **R1a only**.

## Scope Guard

- Markdown is the only report format in the next slice.
- DOCX and XLSX remain later slices.
- Agentic RAG remains out of scope for this change until the report MVP is stable.
- Do not re-implement extraction, page/section persistence, deterministic rules, provider admin, DeepSeek triage, or controlled RAG foundations from the historical task list.
- Reports MUST be generated only from persisted review-run data: document identity, run identity, findings, evidence/provenance, and explicit partial/empty states.
- Strict TDD applies: start with failing report-generation tests, then minimal implementation, triangulation, and refactor.

## Reconciliation Map

| Historical unit | Current status | Evidence / disposition |
| --- | --- | --- |
| 1. Repo scaffolding and strict TDD commands | Completed | Recorded in `apply-progress.md`; current monorepo/test commands exist. |
| 2. API contract and OpenAPI baseline | Completed | Recorded in `apply-progress.md`; current API route contracts exist. |
| 3. PostgreSQL schema and migration baseline | Completed / evolved | Baseline exists and later migrations extended it. |
| 4. Upload and object storage abstraction | Completed / evolved | Upload flow exists in current API and UI paths. |
| 5. Review-run lifecycle and queue orchestration | Completed / evolved | Current review-run lifecycle and orchestration are implemented. |
| 6. Worker parser pipeline contract | Superseded by later completed changes | `precise-thesis-review-pipeline` archive created `document-structure-extraction` with PDF/DOCX extraction behavior. |
| 7. Page/section persistence integration | Superseded by later completed changes | Canonical `document-structure-extraction` includes structural persistence to `document_page` and `document_section`. |
| 8. Evidence and finding contract validator | Partially superseded; no standalone slice now | Current CAG/repository paths reject ungrounded findings and persist evidence provenance. Revisit only if a future slice needs a dedicated shared validator. |
| 9. Rule engine MVP — writing/style first | Superseded by later completed changes | Canonical `deterministic-writing-rules` covers deterministic writing/style rules. |
| 10. Rule engine MVP — GT and APA frameworks | Superseded by later completed changes | Canonical `reglamento-structure-rules`, `apa6-citation-rules`, and `normative-source-governance` cover the implemented GT/APA scope. |
| 11. Congruence validation framework | Future product slice | Still valuable, but not required before Markdown report MVP. Needs fresh proposal/spec before implementation. |
| 12. Controlled RAG normative sources | Partially superseded; future source-admin slice remains possible | `reviewer-workflow-board` covers normative segments, embeddings, retrieval, and provenance; source-management routes are not the next slice. |
| 13. Report generation MVP — Markdown | Current next slice | Implement now. |
| 14. Report generation later slices — DOCX and XLSX | Future slice | Split after Markdown stabilizes. |
| 15. Agentic RAG later milestone scaffold | Future slice | Defer until deterministic + report workflow is stable. |
| 16. Final verification and documentation | Later close-out | Run after the chosen remaining slices are complete. |

## Current Work Units

### R1a. Markdown report contract core

This slice is pure report shaping. It MUST NOT touch the database repository, HTTP route handlers, storage adapter, or UI.

- [ ] RED: Add focused tests for a reusable report view-model and Markdown renderer using in-memory fixture data:
  - completed run with findings;
  - completed run with no valid findings;
  - pending/unavailable report state;
  - partial report labeling for failed/cancelled runs with valid intermediate findings.
- [ ] GREEN: Implement a small report module under `apps/api/src/report-artifacts/` that builds a report view-model from provided document/run/finding/evidence records.
- [ ] GREEN: Render Markdown that includes document identity, run identity, finding type, evidence text, page/section or uncertainty, severity/confidence, normative provenance when present, and provider/model provenance when available.
- [ ] TRIANGULATE: Empty reports state that no valid findings were produced and never invent observations.
- [ ] REFACTOR: Keep the view-model independent from persistence so future DOCX/XLSX can reuse it.
- [ ] Verify: focused report module tests and `git diff --check`.
- [ ] Rollback: delete the report module and focused tests only.

### R1b. Markdown report persistence seam

Run this only after R1a is complete.

- [ ] RED: Add repository/storage tests for report source reads, same-run artifact lookup, wrong-run artifact rejection, and immutable Markdown artifact insertion.
- [ ] GREEN: Add repository methods that read persisted document/run/finding/evidence/provenance data for a review run.
- [ ] GREEN: Add artifact persistence that stores Markdown metadata in `report_artifact` and writes content through the existing storage abstraction.
- [ ] TRIANGULATE: Repeated generation for the same run/version reuses the existing artifact instead of overwriting it.
- [ ] Verify: focused API repository/report tests plus relevant full API tests.
- [ ] Rollback: remove repository/report persistence methods without deleting findings or review-run data.

### R1c. Report artifacts HTTP integration

Run this only after R1a and R1b are complete.

- [ ] RED: Add API contract tests proving `GET /api/v1/review-runs/{run_id}/report-artifacts` returns generated/persisted Markdown artifacts, pending state, and wrong-run protection.
- [ ] GREEN: Wire the existing route in `apps/api/src/api-contract.mjs` to the persistent Markdown generator.
- [ ] TRIANGULATE: Pending/non-terminal runs return an explicit pending/unavailable state and do not expose stale artifacts.
- [ ] Verify: route-focused API tests plus the relevant full API command.
- [ ] Rollback: restore the prior pending/static artifact route behavior while keeping R1a/R1b modules isolated.

### R2. Optional report download UI polish

Run this only if R1c exposes a new artifact shape that the current UI cannot consume.

- [ ] RED: Add web helper tests for selecting and presenting Markdown report artifacts from the API response.
- [ ] GREEN: Update the results/review-board UI to show a clear Markdown download or unavailable state.
- [ ] TRIANGULATE: Completed run with no artifact shows a pending/unavailable state, not a broken link.
- [ ] Verify: `pnpm --filter @pg1/web test`.
- [ ] Rollback: revert UI-only download affordance; API report artifacts remain available.

### R3. Final verification for reconciled MVP core

Run only after R1a/R1b/R1c are complete and R2 is either complete or explicitly not needed.

- [ ] RED: Add or update an end-to-end contract test for upload → review run → persisted findings → Markdown report artifact.
- [ ] GREEN: Wire any missing minimal path needed for that contract without expanding into DOCX/XLSX or agentic work.
- [ ] TRIANGULATE: Add failure-path coverage for unsupported upload, extraction/review failure, and partial report labeling.
- [ ] REFACTOR: Update `README.md`, `openspec/README.md`, or `docs/` only where the report workflow changes operator/user commands.
- [ ] Verify: root verification command, API tests, worker tests, and web tests if UI changed.
- [ ] Rollback: keep migration rollback and storage cleanup instructions documented.

## Future Work Not In This Slice

- Congruence validation framework.
- Normative-source admin/indexing routes beyond the already implemented retrieval foundation.
- DOCX and XLSX report generation.
- Agentic RAG module scaffold.
- Deployment-specific DeepSeek smoke with a real `DEEPSEEK_API_KEY`.

## Suggested PR Chain

1. **PR 1 — Markdown report MVP**: R1 only.
2. **PR 2 — UI download polish**: R2 only if needed.
3. **PR 3 — Final MVP verification/docs**: R3 after R1/R2.
4. **Later PRs**: congruence, source-admin routes, DOCX/XLSX, and agentic scaffold as separate product slices.
