# Exploration: `reviewer-authentication` — real auth/authz for PG1

## Current State

**1. No identity/session concept exists anywhere in the data model.** Confirmed by reading all six migrations (`apps/api/src/db/migrations/000{1..6}_*.sql`). There is no `user`, `reviewer`, `account`, or `session` table. Two columns imply identity but enforce nothing:
- `thesis_document.uploaded_by_user_id BIGINT NOT NULL` — no `REFERENCES` clause (no FK, no users table to point at). In code (`apps/api/src/live-review-pipeline.mjs:296`, `apps/api/src/db/review-repository.mjs:391`) it is literally hardcoded to `uploaderUserId ?? 0`, documented in a comment as "a documented [workaround since the] column is `NOT NULL`".
- `audit_event.actor_user_id BIGINT` — nullable, also no FK, unused for real identity today.

**2. This is a single-role, reviewer-only tool — no student-facing account was ever described or implied anywhere in the repo.** README.md: "Un revisor sube la tesis... desde la vista de detalle de un estudiante" — the student is the subject being reviewed, never an actor. Grepped all 6 `openspec/specs/*.md` and both live `openspec/changes/*/proposal.md` — zero mentions of a student login, portal, or role beyond "reviewer"/"admin". `HISTORY.md`'s own roadmap explicitly deprioritizes this: under "Próximos Pasos → Prioridad Baja" it lists `1. Multiusuario` and `2. Panel docente` — i.e., the project's own historical planning treats multi-user accounts and a teacher panel as *low-priority future work*, not current scope. This directly answers the "who logs in" question (see Recommendation).

**3. `review_workflow_item.approval_state` — the human-approval gate — does not record WHO approved today, only an optional self-reported string.** `apps/api/src/db/review-repository.mjs:576-583`: `approveReviewBoardCard(boardCardId, { reviewerName = null })` sets `approval_state = 'approved', reviewer_name = COALESCE($2, reviewer_name)`. `reviewerName` comes straight from the request body (`apps/api/src/api-contract.mjs:154`: `body.reviewerName ?? body.reviewer_name ?? null`) — unverified free text, not bound to any authenticated identity. Anyone hitting `POST /api/v1/review-board/cards/{card_id}/approval` can approve a thesis and claim to be anyone.

**4. The admin gate is real server-side validation, just not real auth.** `apps/web/src/app/admin/admin-secret-store.ts` is an in-memory-only (never localStorage) session signal holding a shared secret entered via `window.prompt`; `admin-api-client.ts` attaches it as `x-admin-secret` header. Server side, `apps/api/src/admin-contract.mjs:214-239` (`checkAdminSecretHeader`) does a real **constant-time comparison** against `process.env.ADMIN_SHARED_SECRET`, returning `401` (missing) / `403` (wrong). It is enforced twice — at the NestJS boundary via `AdminSecretGuard` (`apps/api/src/admin/admin-secret.guard.ts`, applied with `@UseGuards(AdminSecretGuard)` on `AdminController`) and again inside the pure `handleAdminRequest` (defense-in-depth). So: real backend check, but it is one shared static secret with zero identity — the component's own UI copy says so verbatim ("NOT real authentication... Never share it outside the admin team").

**5. Zero access control on every other route.** `ReviewBoardController`, `ThesisDocumentsController`, `ReviewRunsController` (`apps/api/src/{review-board,thesis-documents,review-runs}/*.controller.ts`) have no `@UseGuards` at all — confirmed by reading all three files fully. This covers all 8 non-admin routes: upload, list documents, trigger review runs, get run/findings/report-artifacts, list/patch board cards, approve. Matches `apps/web/src/app/app.routes.ts`: `/upload`, `/runs/:runId`, `/review-board`, `/students/:studentId/review` all have no route guard either.

**6. No auth-related dependency exists anywhere in the stack today.** `apps/api/package.json` dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `pg`, `reflect-metadata`, `rxjs` — no `@nestjs/passport`, `@nestjs/jwt`, `bcrypt`, `argon2`, `cookie-parser`, or `express-session`. `infra/docker-compose.yml` runs only `pgvector/pgvector:pg16` — no Redis, no session store. `openspec/config.yaml` lists "Redis + BullMQ" under `architecture.stack_recommendation.queue`, but that's an aspirational doc — nothing in `infra/` or `package.json` backs it; it is not deployed.

**7. No institutional SSO signal anywhere.** Grepped the whole repo (case-insensitive) for `umg.edu`, `Google Workspace`, `SSO`, `OAuth`, `LDAP`, `Active Directory`, `SAML`. The only real hits are `openspec/decisions/0001-platform-stack-and-ingestion.md:64`, which explicitly **rejects** OneDrive integration specifically *because* "Adding it early introduces OAuth, permissions, file-version ambiguity..." — i.e. the one place OAuth is discussed, it's discussed as a reason to avoid it for now. `docs/normativa-catedra.md` and `HISTORY.md` contain zero institutional-identity requirements — they only cover academic formatting/citation rules and a short list of previously-reviewed theses, nothing about who the platform's users are beyond "revisor."

**8. Test blast radius is smaller than it looks.** All 19 files in `apps/api/tests/` call the pure `handleApiRequest`/`handleAdminRequest` functions directly — there is **no** `supertest`/`INestApplication`/live-HTTP test anywhere in the suite. That means adding `@UseGuards(...)` to the three unprotected controllers breaks **zero** existing tests (none of them go through the NestJS HTTP layer). It also means real enforcement/test-coverage must live in the pure `.mjs` contract functions (mirroring `checkAdminSecretHeader`), not only in a NestJS guard — otherwise the enforcement path has zero test coverage, which conflicts with this repo's `Strict TDD Mode: enabled` and its own established pattern (`admin-contract.test.mjs` unit-tests `checkAdminSecretHeader` directly, decoupled from NestJS).

## Affected Areas

- `apps/api/src/db/migrations/0007_*.sql` (new) — needed only if identity moves beyond a single shared secret (see Approaches).
- `apps/api/src/admin-contract.mjs`, `apps/api/src/admin/admin-secret.guard.ts` — the exact pattern to replicate/retire.
- `apps/api/src/review-board/review-board.controller.ts`, `apps/api/src/thesis-documents/thesis-documents.controller.ts`, `apps/api/src/review-runs/review-runs.controller.ts` — currently zero guards; need protecting.
- `apps/api/src/api-contract.mjs` — where `handleApiRequest` lives; enforcement should be added here too (mirroring `checkAdminSecretHeader`), not only at the NestJS guard layer, to keep test coverage under `node --test`.
- `apps/api/src/db/review-repository.mjs:576-583` — `approveReviewBoardCard`'s `reviewerName` param needs to be sourced from an authenticated identity instead of client-submitted free text, if attribution is in scope.
- `apps/web/src/app/admin/admin-secret-store.ts`, `admin-api-client.ts` — candidate for replacement/generalization into a real session store shared by all routes, not just admin.
- `apps/web/src/app/app.routes.ts` — needs route guards (`canActivate`) once a session concept exists.
- `apps/api/tests/admin-contract.test.mjs` — the closest existing precedent test to model new auth tests on.
- `apps/api/package.json` — will need a new dependency (bcrypt/argon2 at minimum; possibly `@nestjs/jwt` or nothing if hand-rolling a DB-backed session, matching the codebase's existing preference for small hand-rolled pure functions over heavy framework machinery).

## Approaches

### 1. Widen the existing shared-secret pattern to all routes
Reuse `AdminSecretGuard`/`checkAdminSecretHeader` verbatim across `ReviewBoard`, `ThesisDocuments`, and `ReviewRuns` controllers; one static `REVIEWER_SHARED_SECRET` env var, no DB table.
- **Pros**: near-zero new code, zero new dependencies, exactly matches the codebase's own existing precedent, doesn't touch tests (already zero coverage risk).
- **Cons**: does not solve the `reviewer_name` attribution gap (point 3) — one shared secret still can't tell you *who* approved anything; a leaked secret compromises the whole tool with no revocation per-person; doesn't scale even to a small named team without becoming a de-facto password everyone shares indefinitely.
- **Effort**: Low.

### 2. Lightweight multi-account reviewer session auth (no RBAC, single role) — RECOMMENDED
New `reviewer` table (`id`, `email`, `password_hash`, `display_name`, `created_at`), bcrypt/argon2 hashing, a login endpoint issuing an httpOnly session cookie or short-lived JWT validated against Postgres (no Redis needed), a `SessionGuard` mirroring `AdminSecretGuard`'s shape exactly, and a pure `checkSession(...)` function in `api-contract.mjs` mirroring `checkAdminSecretHeader` (same defense-in-depth + unit-testability pattern already established). Retire the standalone admin shared secret — admin routes become "any authenticated reviewer," since evidence shows no distinct admin role exists beyond "the admin team" who are the same reviewers. `approveReviewBoardCard` binds `reviewer_name` to the session's identity instead of trusting client input.
- **Pros**: solves the real gap (point 3 attribution), idiomatic to the existing stack (NestJS Guard + pure testable function, no new infra), no Redis dependency, directly follows the repo's own already-proven pattern, matches team size implied by the evidence (small named reviewer group, not open registration).
- **Cons**: new migration, new dependency (bcrypt/argon2), new login UI + Angular auth store/interceptor, more surface than approach 1; needs a small number of test files updated/added (`admin-contract.test.mjs`-equivalent for the new guard, plus wiring `reviewer_name` in `review-repository.test.mjs`).
- **Effort**: Medium.

### 3. Full multi-role RBAC (reviewer/admin/student roles + permission matrix)
Roles table, permission checks per route, student self-service login.
- **Pros**: future-proof if the platform later grows a student portal or teaching-panel differentiation.
- **Cons**: no evidence anywhere in the repo supports this now — contradicts `HISTORY.md`'s own roadmap, which explicitly defers "Multiusuario" and "Panel docente" to low priority; would be inventing scope not asked for or grounded in the product as it exists.
- **Effort**: High.

### 4. Reverse-proxy/basic-auth in front of the app
nginx/Caddy Basic Auth, or a hosted access proxy — app code untouched, auth enforced at the infra layer.
- **Pros**: fastest to stand up, zero application code changes, no new backend dependency.
- **Cons**: cannot solve the `reviewer_name` attribution gap at all unless the proxy forwards an identity header the app then trusts blindly (reintroducing a shared-secret-style trust problem, worse because it's implicit); adds an infra component not present in `infra/docker-compose.yml` today; architecturally inconsistent with the pattern the codebase has already invested in (`AdminSecretGuard`, pure-function contract tests) — the team already chose in-app enforcement once and has a proven pattern for it.
- **Effort**: Low–Medium (proxy config + hosting decision), but effectively a dead end for point 3.

## Recommendation

**Approach 2 — lightweight multi-account reviewer session auth, single role, no RBAC.**

Grounded answer to "who logs in": a small, explicitly-provisioned set of named reviewer accounts (the same people currently sharing the admin secret) — not a shared credential, not per-student accounts, not multi-role RBAC. This is the smallest change that both (a) fixes the concrete, already-identified integrity gap in `review_workflow_item.approval_state`/`reviewer_name` (currently unverified free text on a field the product itself calls "human-owned, never automated") and (b) matches the codebase's own established guard+pure-function pattern exactly, so it inherits the existing test discipline instead of introducing an untested enforcement path. It requires no new infrastructure (no Redis, DB-backed sessions/JWT against the already-running Postgres are sufficient) and no new architectural component (reuses `@UseGuards` + a pure `.mjs` check function, same shape as `AdminSecretGuard`/`checkAdminSecretHeader`). It also lets the standalone admin shared-secret hack be retired outright rather than widened, since there is no evidence of a distinct admin role separate from the reviewer team.

Explicitly **not** recommended: full RBAC/student accounts (approach 3) — no grounding in the repo, and directly contradicts `HISTORY.md`'s own "Multiusuario"/"Panel docente" = low-priority framing; and reverse-proxy-only (approach 4) — can't solve the attribution problem the product already needs solved.

## Risks

- Scope creep risk: it's tempting to fold in password reset, MFA, or rate-limiting on login in v1 — none of that is grounded as required by any evidence found; recommend deferring to a follow-up unless `sdd-propose` finds a concrete reason.
- The 400-line PR review budget (per `openspec/config.yaml` `phase_rules.max_review_lines: 400`) will very likely be exceeded by a single PR covering migration + guard + pure-function + Angular login UI + route guards + retiring the admin secret; `sdd-tasks` should plan chained/stacked slices.
- Retiring `AdminSecretGuard`/`ADMIN_SHARED_SECRET` is itself a behavior change to an already-shipped, spec'd feature (`openspec/specs/llm-provider-admin/spec.md` — "Requirement: Admin Shared-Secret Access Gate (Temporary MVP)"); `sdd-propose`/`sdd-spec` should treat this as a `MODIFIED`/`REMOVED` delta against that existing spec, not a silent removal.
- `uploaded_by_user_id ?? 0` and `audit_event.actor_user_id` currently accept no real user — wiring real reviewer IDs through upload/audit paths is in scope if attribution is meant to be end-to-end, which enlarges the change beyond just login+approval-gate; worth an explicit scope decision in `sdd-propose`.

## Ready for Proposal

Yes. Evidence is sufficient and unambiguous on all six investigation points; the product-scope question (single-role reviewer accounts, no student/RBAC) is answered with direct repo evidence, not left open. Route to `sdd-propose` for `reviewer-authentication`.

## Key Learnings

1. PG1 has zero identity/session tables in any of its 6 migrations; `uploaded_by_user_id` is a NOT-NULL column with no FK, hardcoded to `0` in code.
2. `review_workflow_item.reviewer_name` is unverified client-submitted free text, so the platform's only human-approval gate currently records no real approver identity.
3. All 19 files in `apps/api/tests/` call pure contract functions directly with no live NestJS/supertest layer, so adding `@UseGuards` to controllers breaks zero existing tests but also means enforcement needs a pure-function counterpart for real test coverage.
4. `HISTORY.md`'s own roadmap lists "Multiusuario" and "Panel docente" under low-priority future work, directly grounding a single-role v1 auth scope over full RBAC.
5. The admin shared-secret gate (`AdminSecretGuard`/`checkAdminSecretHeader`) is genuinely enforced server-side via constant-time comparison against `ADMIN_SHARED_SECRET`, not merely a client-side header.
