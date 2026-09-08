# Proposal: Reviewer Authentication

## Intent

PG1 has no identity. Its only human-owned gate — `review_workflow_item.approval_state` — stores `reviewer_name` as unverified client free text (`api-contract.mjs:154` → `review-repository.mjs:576-583`), so any unauthenticated caller can approve a thesis as anyone. All 8 non-admin routes have zero access control; the one real server-side check (`AdminSecretGuard`) is a shared secret whose own UI copy says "NOT real authentication". Give named reviewers real accounts and bind approvals to them.

## Scope

### In Scope
- Migration `0007`: `reviewer` + `reviewer_session` tables; argon2id hashing.
- Login/logout endpoints; opaque DB-backed session token; login throttle; generic invalid-credential error (no user enumeration); failed-login audit events.
- `SessionGuard` (mirrors `AdminSecretGuard`) + pure `checkSession()` in `api-contract.mjs` (mirrors `checkAdminSecretHeader`), on ReviewBoard / ThesisDocuments / ReviewRuns / Admin controllers.
- Angular in-memory session store, HTTP interceptor, `canActivate` route guards; replaces `admin-secret-store.ts`.
- Attribution: `approveReviewBoardCard` derives reviewer identity from the session, never the body; `thesis_document.uploaded_by_user_id` receives the real reviewer id instead of `0`; `audit_event.actor_user_id` populated on authenticated request paths.
- Retire `ADMIN_SHARED_SECRET` / `AdminSecretGuard` / `checkAdminSecretHeader`.
- Operator-run account provisioning (seed/CLI).

### Out of Scope
Student accounts, RBAC/roles, SSO/OAuth/LDAP/SAML (`decisions/0001` rejects OAuth; `HISTORY.md` defers "Multiusuario"/"Panel docente"), MFA, password reset/email, self-registration, FK constraint on legacy `uploaded_by_user_id = 0` rows, historical backfill, `actor_user_id` on automated pipeline events, httpOnly-cookie/CSRF scheme.

**Attribution decision (explore left this open):** end-to-end attribution is IN. The session object is already threaded through these exact handlers by the guard work; deferring means every row written post-launch stays unattributable and costs a second migration plus a second pass over the same call sites. Only backfill and FK enforcement are deferred.

## Capabilities

### New Capabilities
- `reviewer-authentication`: accounts, credential verification, session lifecycle, route protection, identity-bound attribution.

### Modified Capabilities
- `llm-provider-admin`: **REMOVED** requirement "Admin Shared-Secret Access Gate (Temporary MVP)", replaced by an authenticated-reviewer session gate. Honest delta, not a silent deletion: the temporary MVP gate is superseded, `401` on missing/invalid session is preserved, `403` on wrong-secret disappears (no separate admin role exists — admin becomes "any authenticated reviewer").
- `reviewer-workflow-board`: "Priority and Approval Workflow State" — approver identity MUST come from the session, not the request body.
- `vertical-slice-cag-review`: "UI-Driven Thesis Upload" — upload requires a session and records the real uploader.

## Approach

Explore approach 2, refined on two points:

1. **Opaque session token over JWT.** Random token, SHA-256-hashed in `reviewer_session` with `expires_at`; instant server-side revocation, no signing-secret or algorithm-confusion class of bugs, no dependency beyond argon2.
2. **In-memory Angular store + `Authorization: Bearer` over cookies.** Mirrors the existing never-persisted `admin-secret-store` precedent: no ambient credential means no CSRF surface, and no localStorage token to steal via XSS. Accepted tradeoff: a full page reload requires re-login.

Enforcement is duplicated at the NestJS guard and the pure contract function so `node --test` actually covers it — no supertest/live-HTTP layer exists in the suite.

OWASP controls applied: A01 (deny-by-default guards on every route), A02 (argon2id, hashed session tokens), A07 (login throttle, generic errors, constant-time compare, expiring revocable sessions), A09 (auth-failure audit events).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/api/src/db/migrations/0007_*.sql` | New | `reviewer`, `reviewer_session` |
| `apps/api/src/auth-contract.mjs` | New | Pure `checkSession`, `verifyCredentials`, throttle |
| `apps/api/src/auth/session.guard.ts` | New | Mirrors `AdminSecretGuard` |
| `apps/api/src/api-contract.mjs` | Modified | Session enforcement; approval identity from session |
| `apps/api/src/db/review-repository.mjs` | Modified | `approveReviewBoardCard`, uploader id, audit actor |
| `apps/api/src/live-review-pipeline.mjs` | Modified | Drops `uploaderUserId ?? 0` |
| `apps/api/src/{review-board,thesis-documents,review-runs}/*.controller.ts` | Modified | Add `@UseGuards(SessionGuard)` |
| `apps/api/src/admin-contract.mjs`, `admin/admin-secret.guard.ts` | Removed | Shared secret retired |
| `apps/web/src/app/auth/*` | New | Session store, interceptor, login page, route guards |
| `apps/web/src/app/admin/admin-secret-store.ts`, `admin-api-client.ts` | Removed/Modified | Replaced by session store |
| `apps/web/src/app/app.routes.ts` | Modified | `canActivate` on all routes |
| `apps/api/tests/` | New/Modified | Auth contract tests; `admin-contract.test.mjs` retired |
| `apps/api/package.json` | Modified | `argon2` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Exceeds the 400-line review budget | High | `sdd-tasks` plans chained slices: (1) schema+auth contract, (2) API guards + admin retirement, (3) attribution wiring, (4) Angular login/guards |
| Removing the admin gate locks out operators mid-deploy | Med | Ship account provisioning in slice 1; document required seed step before slice 2 deploys |
| Re-login on page reload frustrates reviewers | Med | Named tradeoff; httpOnly-cookie + CSRF token is the documented follow-up |
| Legacy `uploaded_by_user_id = 0` rows can never be attributed | High | Accepted; no FK added, `0` is documented as "pre-auth, unattributed" |
| argon2 native build fails in CI/Docker | Low | Fall back to `bcrypt` (cost 12); decide in `sdd-design` |

## Rollback Plan

Per slice. Revert the commit; `0007` rollback drops `reviewer_session` and `reviewer` (additive tables, no FK, no data loss elsewhere). If slices 1–3 shipped and slice 4 must be reverted, restore `AdminSecretGuard` + `ADMIN_SHARED_SECRET` from git history and re-set the env var — attribution columns simply return to `0`/`NULL` defaults.

## Dependencies

- `argon2` (or `bcrypt`) in `apps/api`.
- Postgres 16 already running (`infra/docker-compose.yml`); no Redis, no new infrastructure.
- Operator must provision at least one reviewer account before the admin secret is removed.

## Success Criteria

- [x] Every non-login API route returns `401` without a valid session.
- [x] Approving a card with a forged `reviewerName` body field records the session identity, not the submitted value.
- [x] A new upload persists a real `uploaded_by_user_id`, never `0`.
- [x] `ADMIN_SHARED_SECRET` appears nowhere in the codebase or environment.
- [x] Repeated failed logins are throttled and audited; responses never reveal whether the account exists.
- [x] `pnpm test` passes with new pure-function auth tests under `node --test`.

## Open product questions — resolved

1. **Account provisioning** — CONFIRMED by user: an operator runs a seed/CLI command and hands the password over out-of-band, same pattern as today's admin secret.
2. **Re-login on full page reload** — accepted default, matches existing admin-secret behavior (also never persisted). Not challenged.
3. **Existing free-text `reviewer_name` on past approvals** — accepted default: leave as-is, no backfill/migration touches historical rows. Not challenged.
4. **Admin/reviewer separation** — CONFIRMED by user: any authenticated reviewer can edit LLM provider credentials. No distinct admin role/permission flag is in scope.
5. **Lockout policy** — accepted default: throttle only, no hard account lock requiring operator intervention. Not challenged.
