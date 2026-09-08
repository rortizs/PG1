# Verification Report: reviewer-authentication

**Verdict**: PASS (0 CRITICAL, 3 WARNING — all artifact-checkbox staleness, not functional gaps, since fixed; 2 SUGGESTION)

## What was checked (fresh, independent — not trusted from commit messages)

- Read `proposal.md`, `design.md`, `tasks.md`, and all 4 `specs/*/spec.md` files in full.
- Source-inspected the actual code on `master` against design D1-D12: migration `0007` matches D1 byte-for-byte; `auth-contract.mjs`/`password-hasher.mjs`/`reviewer-repository.mjs`/`seed-reviewer.mjs` match D2-D5/D10; `session.guard.ts`/`auth.controller.ts` exist and are wired; all 4 controllers (`ReviewBoardController`, `ThesisDocumentsController`, `ReviewRunsController`, `AdminController`) use `@UseGuards(SessionGuard)`.
- Grepped the whole repo independently: `ADMIN_SHARED_SECRET`/`AdminSecretGuard`/`checkAdminSecretHeader`/`constantTimeEquals` appear nowhere except inside the grep-assertion test that checks for their absence.
- Confirmed `approveReviewBoardCard` writes `reviewer_name`/`approved_by_reviewer_id` from `{reviewerId, reviewerName}` with no `COALESCE` fallback, and that `api-contract.mjs`'s approval handler no longer reads `body.reviewerName`.
- Confirmed `registerUploadedDocument` throws on null/undefined `uploaderUserId` instead of `?? 0`.
- Confirmed the full Angular `auth/*` surface exists, `admin-secret-store.ts` is deleted, and `app.routes.ts` has `canActivate: [requireSession]` on all 5 pre-existing routes plus a public `login` route.
- Ran the real test suites fresh: `pnpm --dir apps/api test` → **151/151**. `pnpm --dir apps/web test` → **70/70**. `pnpm --dir apps/web build` → clean.
- Ran a fresh live-HTTP smoke test against a booted server + real Postgres reads: 401 with no session, 201 login, generic 401 on wrong password (no enumeration), 200 with a valid session, 204 idempotent logout (including on replay), 401 after revocation. Critically: approved a card with a forged `reviewerName: "Someone Else Entirely"` request body, then read the row directly via `SELECT` — persisted value was the real session identity, never the forged one. Audit trail (`login_succeeded`, `login_failed`, `logout`, `card_approved`) correctly attributed to the real reviewer id.
- Confirmed all 6 of `proposal.md`'s Success Criteria are genuinely met.

## Findings

**CRITICAL**: None.

**WARNING** (all fixed by the orchestrator immediately after verify, before archive):
1. `tasks.md`'s Unit 3a had all 9 checkboxes still `[ ]` even though that exact work (SessionGuard, enforcement gate, admin-secret retirement) was fully shipped and tested in commit `a170638` — a task-tracking artifact of bundling PR2+3a into one commit during apply, not a code gap. Fixed: checkboxes now `[x]`.
2. `proposal.md`'s 6 Success Criteria checkboxes were still `[ ]` despite all being genuinely met. Fixed: checkboxes now `[x]`.
3. Commits `a170638` (PR2+3a) bundle two SDD work units into one commit, and `0eb5eb4`/`808dcab` are not in the exact tasks.md-planned PR order (PR4 committed before PR3b) — documented and intentional (files were too intertwined to split after the fact; order reflects when each apply agent's work was independently verified), not a defect.

**SUGGESTION**:
1. `docker start pg1-db` on this host does not always preserve prior schema state reliably on the very first query attempt immediately after restart — re-running `migrate.mjs up` before verification is a safe habit for future work on this project's local dev environment.
2. The manual account-provisioning gate (design D12) has still only been exercised locally, never against any real deployment target — flag before this change is considered production-ready, not just code-complete.

## Test Results

- **API tests**: 151/151 pass (fresh run).
- **Web tests**: 70/70 pass (fresh run).
- **Web build**: clean, exit 0.
- **Total**: 221/221.

## Success Criteria Compliance

All 6 of `proposal.md`'s Success Criteria confirmed met (see above) — checkboxes updated to `[x]`.

## Spec Compliance

7 requirements, 18 scenarios across 4 domains (`reviewer-authentication` NEW; `llm-provider-admin` REMOVED delta; `reviewer-workflow-board`, `vertical-slice-cag-review` MODIFIED deltas) — all COMPLIANT, validated via `gentle-ai sdd-verify-validate --requirements 7 --scenarios 18` → `pass_with_warnings`.

---

**Verified**: 2026-09-04
**Next**: sdd-archive
