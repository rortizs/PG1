# Tasks: Reviewer Authentication

> Size note: this artifact exceeds the generic 530-word budget, following the same house
> exception `design.md` already claims and the RED/GREEN/TRIANGULATE/REFACTOR/Verify/Rollback
> convention established by `thesis-normative-governance/tasks.md`. Strict TDD mode requires
> each RED row to state a genuine, checkable failure mode, not a placeholder — that requires
> prose, not a one-line checklist. Design's own D12 hard-ordering constraint (3a/3b must merge
> together) also requires the PR-chain section to spell out branch topology explicitly.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR1 ~480-580 · PR2 ~240-330 · PR3a ~280-380 · PR3b ~320-420 · PR4 ~180-250 (all figures are `additions + deletions`, i.e. include tests and D11's deletions — wider than design.md's "550-700 authored production lines" figure, which counted production code only) |
| 400-line budget risk | PR1: High · PR2: Medium · PR3a: Medium-High · PR3b: Medium-High · PR4: Low-Medium |
| Chained PRs recommended | Yes |
| Suggested split | Tracker → PR1 (schema+contract+repo+seed) → PR2 (login/logout+audit) → {PR3a (API enforcement) + PR3b (Angular auth), joint merge} → PR4 (attribution) |
| Delivery strategy | auto-chain |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

PR1 is the single largest slice: one migration, one new pure module, one new repository module,
and one new CLI script, each carrying its own test file per the Testing Strategy table. It stays
one PR because design.md fixes it as one atomic, independently-deployable ("dormant, zero
behavior change") unit — splitting it further would separate a table from the code that depends
on it for no rollback benefit. PR3a and PR3b are sized separately but **never independently
mergeable** — see Scope Guard and Suggested PR Chain below.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Migration `0007`, `password-hasher.mjs`, pure/fake-repo `auth-contract.mjs`, `reviewer-repository.mjs`, `seed-reviewer.mjs` | PR1 | `pnpm --dir apps/api test` | dockerized pg, `migrate.mjs up`/`down` | `migrate.mjs down` for `0007`; delete the 4 new files |
| — | Manual gate: operator runs `seed-reviewer.mjs`, verifies the created account logs in | between PR1 and PR2 | N/A — operational step, not code | real deployment / staging DB | N/A |
| 2 | `POST`/`DELETE /api/v1/auth/sessions`, `insertAuditEvent`, login/logout audit events | PR2 | `pnpm --dir apps/api test` | dockerized pg | revert route additions + `insertAuditEvent`; routes were public, no consumer depended on them |
| 3a | `SessionGuard`, `checkSession` gate in `handleApiRequest`, controllers pass `headers`, admin-secret retirement (D11) | PR3a (joint with 3b) | `pnpm --dir apps/api test` | dockerized pg | restore `AdminSecretGuard`/`ADMIN_SHARED_SECRET` from git history; **only safe together with reverting 3b** |
| 3b | Angular `auth/*`, login page, interceptor, route guards, `AdminSecretStore` removal | PR3b (joint with 3a) | `pnpm --dir apps/web test` | N/A — pure/unit Angular, no live browser harness in this suite | restore `admin-secret-store.ts`/`AdminApiClient.withSecret`; **only safe together with reverting 3a** |
| 4 | Attribution: approval identity, uploader id, `?? 0` removal, approve/upload audit actors | PR4 | `pnpm --dir apps/api test` | dockerized pg | revert the 3 call-site diffs; attribution columns return to `0`/`NULL` defaults, no data loss |

## Scope Guard

- Deny-by-default (OWASP A01): every route under `/api/v1/thesis-documents`, `/api/v1/review-runs`,
  `/api/v1/review-board`, `/api/v1/admin` MUST 401 with no session **before** any handler logic
  runs — proven by a full-route contract sweep, not by convention (PR3a).
- No plaintext password ever stored or logged (OWASP A02) — `password_hash` holds only a PHC
  string; `seed-reviewer.mjs --password <value>` is a hard-rejected flag, never a working one.
- `checkAdminSecretHeader`/`constantTimeEquals`/`ADMIN_SHARED_SECRET` MUST appear in zero files
  under `apps/` and `docs/` once PR3a lands — proven by a repo-wide grep-assertion test, mirroring
  the D8/D9 structural-proof precedent in `thesis-normative-governance`.
- No request body field (`reviewerName`, `reviewer_name`, `uploaderUserId`) may ever reach a
  write path once a session exists to source that identity from (D8) — the body fields are
  **deleted, not ignored**, at the call site.
- `uploadedByUserId ?? 0` MUST NOT survive PR4 — a null `uploaderUserId` reaching
  `live-review-pipeline.mjs:296` throws loudly instead of silently defaulting.
- Unknown email, wrong password, inactive account, and throttled account MUST all resolve through
  `verifyCredentials` to byte-identical response bodies (OWASP A07 — no enumeration oracle),
  proven directly, not just asserted in prose.
- Only the SHA-256 digest of a session token is ever persisted; the schema `CHECK` on
  `token_hash` makes storing a raw token structurally impossible, not merely reviewed-against.
- PR3a and PR3b are never independently on the delivery path to `main` — see Suggested PR Chain.

## Work Units

### 1. Migration `0007` + `password-hasher.mjs` + pure/fake-repo `auth-contract.mjs` + `reviewer-repository.mjs` + `seed-reviewer.mjs`

- [x] RED (migration, real PG, `apps/api/tests/reviewer-auth-migration.test.mjs`): asserts `0007`
      UP creates `reviewer`, `reviewer_session`, and `review_workflow_item.approved_by_reviewer_id`;
      a case-variant email (`"Jane@Foo.com"`) is rejected by the `email = lower(btrim(email))` CHECK;
      a non-hex `token_hash` (e.g. `"not-a-digest"`) is rejected by its CHECK; `expires_at <=
      created_at` is rejected by `reviewer_session_expiry_order_check`; UP then DOWN cycles cleanly.
      Before the migration exists, each assertion fails for a distinct real reason: `relation
      "reviewer" does not exist`, and the CHECK-violation assertions cannot even be exercised
      (`relation does not exist` again) — the migration file genuinely does not exist yet.
- [x] RED (pure, `apps/api/tests/reviewer-auth-contract.test.mjs`): `normalizeEmail(" Jane@Foo.COM ")
      === "jane@foo.com"`, `normalizeEmail("garbage")` returns `""`; `parseBearerToken` reads the
      `Authorization` header case-insensitively (`authorization` vs `Authorization`), returns `null`
      for a missing header and for `"Basic xyz"`, extracts `"abc123"` from `"Bearer abc123"`;
      `hashSessionToken(token)` returns a 64-char lowercase hex string, deterministic for the same
      input; `validatePasswordStrength` rejects an 11-char password and a 129-char password with
      `{ field: "password", message }`, accepts 12 and 128 chars. Before implementation: `TypeError:
      normalizeEmail is not a function` (module does not export any of these names yet).
- [x] RED (pure, same file): `evaluateThrottle`/`nextThrottleState` — 5 consecutive failures within
      `THROTTLE_WINDOW_MS` produce a `429` `errorResponse` with `details.retry_after_seconds`; a 6th
      call before the window elapses is still throttled; a success resets `{ failedLoginCount: 0,
      throttledUntil: null }` (self-clear, no operator intervention). Before implementation: same
      `TypeError`, functions undefined.
- [x] RED (fake-repo, `apps/api/tests/reviewer-auth-credentials.test.mjs`): `verifyCredentials`
      against an injected fake repository — an unknown email and a wrong password for a known email
      return **byte-identical** `{ reviewer: null, error }` bodies (deep-equal after masking
      `request_id`/`timestamp`); an inactive account returns the same body; a 6th failed attempt
      within the window returns `429` for both a known and an unknown email; a success clears the
      fake repo's stored `failedLoginCount`. Before implementation: `TypeError: verifyCredentials is
      not a function`.
- [x] RED (fake-repo, same file): `checkSession` — a valid unexpired unrevoked session resolves to
      `{ session: {...}, error: null }`; an expired row, a `revoked_at`-set row, and an unknown
      `token_hash` all resolve to `{ session: null, error: <401> }`; a missing `Authorization` header
      resolves to the same 401 shape (deny by default). Before implementation: `TypeError:
      checkSession is not a function`.
- [x] RED (pure, `apps/api/tests/reviewer-auth-seed.test.mjs`): `parseSeedArgs` — a `--password`
      flag returns `{ error: <explicit rejection message> }` (never a usable password); a missing
      `--email` returns `{ error }`; `--generate` combined with `--reset-password` returns a valid
      combined-mode object. Before implementation: `TypeError: parseSeedArgs is not a function`
      (`ImportError`-equivalent for `.mjs` — module does not resolve).
- [x] RED (integration, real PG, same file): running `seedReviewer` with `--generate` creates a
      `reviewer` row; the password captured from the CLI's single stdout line round-trips through
      `verifyCredentials` against the fake-repo-free real path (a genuine login succeeds). Running it
      again for the same email fails with "reviewer already exists — use `--reset-password`" rather
      than silently overwriting. Before implementation: `Error: Cannot find module
      '.../seed-reviewer.mjs'`.
- [x] GREEN: Write `0007_reviewer_authentication.sql` exactly per D1 (two additive tables, one
      additive column, both indexes, DOWN in dependency-safe order). Create
      `apps/api/src/security/password-hasher.mjs` per D2 (`hashPassword`, `verifyPassword` — never
      throws, `DUMMY_PASSWORD_HASH`), argon2id primary. Create `apps/api/src/auth-contract.mjs` per
      D3-D5 with the pure functions, `verifyCredentials`, `checkSession`, and
      `_resetAuthContractForTests` (route handlers stay out of scope for this unit — D7's
      `handleAuthRequest` is Unit 2). Create `apps/api/src/db/reviewer-repository.mjs`
      (`createReviewerRepository`, mirrors `provider-config-repository.mjs`: find-by-email,
      create-session, find-session-by-hash, revoke-session, update-login-state). Create
      `apps/api/src/db/seed-reviewer.mjs` per D10 (`parseSeedArgs`, `seedReviewer`, `isMainModule`
      guard, `process.exitCode` on error, stdin-read with echo suppression, no `package.json`
      script).
- [x] TRIANGULATE: an explicit `INSERT ... (precedence-equivalent generated-style column)` is not
      applicable here (no generated column in this migration), but an explicit
      `INSERT INTO reviewer_session (token_hash) VALUES ('deadbeef')` (31 hex chars, too short) is
      rejected by the CHECK, proving the regex bound, not just presence of *a* hex string. An
      unknown email in `verifyCredentials` still burns one `verifyPassword(password,
      DUMMY_PASSWORD_HASH)` call (asserted via a spy on the fake repo / hasher), so response timing
      does not distinguish it from a known-email wrong-password path. `checkSession` on a row whose
      `revoked_at IS NOT NULL` **and** `expires_at` is still in the future is still rejected —
      revocation wins over expiry.
- [x] REFACTOR: `verifyCredentials` and `checkSession` share the same `errorResponse()` shape as
      `admin-contract.mjs`'s existing helper — reuse it rather than duplicating the `{ status, body:
      { error, message, details, request_id, timestamp } }` literal.
      **Deviation**: the apply prompt explicitly restricted this unit to the 5 new deliverable files
      ("nothing outside these 5 new files should be modified") — `admin-contract.mjs` is not one of
      them. Kept a local `errorResponse()` in `auth-contract.mjs`, shape-identical, guarded against
      drift by a dedicated "errorResponse shape parity" test in `reviewer-auth-contract.test.mjs`.
      Literal code-sharing is deferred to whichever later unit is authorized to touch
      `admin-contract.mjs`.
- [x] Verify: `pnpm --dir apps/api test` green; `migrate.mjs up` then `migrate.mjs down` cycles
      cleanly against dockerized pg; a manual `node apps/api/src/db/seed-reviewer.mjs --generate
      --email test@example.com --display-name "Test"` run followed by a `verifyCredentials` call
      against the real repository succeeds.
- [x] Rollback: `migrate.mjs down` for `0007` (drops the FK column before the tables it references,
      per the documented statement order); delete `password-hasher.mjs`, `auth-contract.mjs`,
      `reviewer-repository.mjs`, `seed-reviewer.mjs` — nothing outside this unit imports them yet
      (dormant, zero behavior change, matching D12's row 1).

### 2. Login/logout endpoints + `insertAuditEvent`

- [x] RED (`apps/api/tests/reviewer-auth-routes.test.mjs`, real PG): `POST /api/v1/auth/sessions`
      with valid credentials via `handleApiRequest` returns `201 { type: "reviewer_session", token,
      expires_at, reviewer: { id, email, display_name } }` and a matching `reviewer_session` row
      exists; invalid credentials return `401 unauthorized` + `invalid_credentials`; a blank field
      returns `422 validation_error`; the 6th rapid attempt returns `429` with
      `details.retry_after_seconds`. `DELETE /api/v1/auth/sessions/current` with a valid token
      returns `204` and the row's `revoked_at` is set; called again with the same (now-revoked) token
      still returns `204` (idempotent, never `401`, per D7). Both routes appear in
      `listApiRoutes()`. Before implementation: `handleApiRequest` has no branch for
      `/api/v1/auth/sessions` — the request falls through to the existing "unknown route" `404`
      branch, so every one of these assertions observes `404` instead of its expected status.
- [x] RED (same file): a successful login writes an `audit_event` row with `event_type:
      "login_succeeded"` and `actor_user_id` equal to the reviewer's id; a failed login for a known
      email writes `event_type: "login_failed"` with `actor_user_id` equal to that reviewer's id; a
      failed login for an **unknown** email writes `login_failed` with `actor_user_id IS NULL`
      (never a guessed id — D8's enumeration-oracle note); logout writes `event_type: "logout"`.
      Before implementation: zero rows exist in `audit_event` after any of these calls —
      `insertAuditEvent` does not exist yet (design's own finding: `audit_event` has no writer in
      `apps/api/src` today).
- [x] GREEN: Add `insertAuditEvent({ actorUserId = null, entityType, entityId = null, eventType,
      message = null, metadata = {} })` to `apps/api/src/db/review-repository.mjs` per D8, wrapped in
      `try/catch` so an audit failure never converts a successful request into an error. Add the two
      routes to `api-contract.mjs`'s `ROUTES` table per D7, delegating to `handleAuthRequest` in
      `auth-contract.mjs` (now completed with the route-handler layer on top of Unit 1's pure/
      fake-repo functions).
- [x] TRIANGULATE: logout on a token that was never issued (unknown hash) still returns `204` and
      writes no audit row (nothing to revoke) — no oracle for "does this token exist". A malformed
      JSON body on login returns the existing generic `422`/`400` path, not a 500. Concurrent login
      attempts for the same email within the same throttle window both observe a consistent
      `failedLoginCount` (no lost-update race in the simple sequential test harness).
- [x] REFACTOR: N/A — `insertAuditEvent` is additive, and the two new routes follow the exact
      isolation split the admin routes already use (handler body lives in the `*-contract.mjs`
      module, not inline in `api-contract.mjs`).
- [x] Verify: `pnpm --dir apps/api test` green, including the new route and audit-event cases.
- [x] Rollback: revert the two `ROUTES` entries and `insertAuditEvent`; both routes were public and
      no other code path calls them yet, so removal is a clean revert with no downstream break.

### 3a. `SessionGuard` + `checkSession` gate + controllers + admin-secret retirement

- [x] RED (`apps/api/tests/contract.test.mjs` extension): every route returned by `listApiRoutes()`
      **except** the two auth routes from Unit 2 returns `401 unauthorized` when called with no
      `Authorization` header, and the response asserts nothing was read/created/modified (no side
      effect fired). Before implementation: every one of those routes currently succeeds (or 500s on
      missing test setup) because nothing gates them yet — the assertion of `401` fails against
      whatever status each route returns today.
- [x] RED (same file, or `apps/api/tests/reviewer-auth-guard.test.mjs`): a request bearing an
      expired or unknown token to any protected route also returns `401`; a request bearing a valid
      unexpired token reaches its handler (asserted via a spy/stub handler observing invocation, or
      via a real successful `200`). Before implementation: no `headers` param is even threaded
      through `handleApiRequest`, so a token cannot be presented to be checked at all — the call
      signature itself fails (`TypeError` on the extra argument, or the header is silently dropped
      and the assertion of gated behavior fails).
- [x] RED (repo-wide grep-assertion, new `apps/api/tests/no-admin-secret.test.mjs`): first asserts
      the scanner correctly *fails* against a fixture string containing `ADMIN_SHARED_SECRET`
      (proving it is not a no-op), then walks every file under `apps/` and `docs/` and asserts none
      contain `ADMIN_SHARED_SECRET`, `x-admin-secret`, `checkAdminSecretHeader`, or
      `constantTimeEquals`. Before implementation: the clean-pass assertion fails immediately —
      those identifiers are still present in `admin-contract.mjs`, `admin-secret.guard.ts`,
      `admin-secret-store.ts`, and the runbook.
- [x] RED (`apps/api/tests/admin-contract.test.mjs`, modified): its existing secret-header test
      cases (correct secret → `200`, wrong secret → `403`, missing → `401`) are removed and replaced
      with an assertion that `/api/v1/admin/*` now requires a valid session, following the same
      `401`-on-missing/invalid pattern with **no** `403` branch (per the spec delta). Before
      implementation, the old `403`-on-wrong-secret case still exists and passes against the
      about-to-be-deleted guard — this is the RED signal that the delta is not yet applied.
- [x] GREEN: Wire `checkSession` into `handleApiRequest` per D6 — threaded `headers` parameter, gate
      runs once at the top after the two public auth branches, deny-by-default. Create
      `apps/api/src/auth/session.guard.ts` (async `CanActivate`, throws `UnauthorizedException` on
      401, `ServiceUnavailableException` on the `DATABASE_URL`-unset 503 case, **no** `403` branch).
      Add `@UseGuards(SessionGuard)` + `@Headers() headers` to every controller in
      `{review-board,thesis-documents,review-runs}/*.controller.ts`; swap `AdminSecretGuard` →
      `SessionGuard` in `admin.controller.ts`. Delete `admin/admin-secret.guard.ts`; delete
      `checkAdminSecretHeader`/`constantTimeEquals` from `admin-contract.mjs`; delete
      `ADMIN_SHARED_SECRET` from every remaining reference (env docs, runbook section, compose
      files if present).
- [x] TRIANGULATE: a request to a genuinely unknown route (never in `listApiRoutes()`) still returns
      `404`, and does so **after** the gate would have run for a *known* route — i.e. an unknown path
      is not accidentally leaked as `401` (which would confirm the route's existence) nor bypasses
      the gate. A route added to `ROUTES` later with no explicit guard annotation is still protected
      by the single top-level `handleApiRequest` gate (deny-by-default "protected by omission").
- [x] REFACTOR: N/A — `SessionGuard` copies `admin.controller.ts`'s existing `@UseGuards` wiring
      pattern verbatim per D6; no new abstraction introduced.
- [x] Verify: `pnpm --dir apps/api test` green, including the full contract 401-sweep, the guard
      unit tests, the grep-assertion test, and the updated `admin-contract.test.mjs`.
- [x] Rollback: **only valid together with reverting Unit 3b** (see Scope Guard/PR Chain) — restore
      `admin-secret.guard.ts`, `checkAdminSecretHeader`, `constantTimeEquals`, and
      `ADMIN_SHARED_SECRET` from git history; re-set the env var; remove `SessionGuard`/`headers`
      wiring from controllers and `handleApiRequest`.

### 3b. Angular `auth/*` + login page + interceptor + route guards + `AdminSecretStore` removal

- [x] RED (`apps/web/tests/auth-session-view.test.mjs`): `loginFormIssues("", "")` returns
      non-empty issues for both fields; `loginFormIssues("a@b.com", "validpassword123")` returns
      `[]`; `buildAuthorizationHeader("tok")` returns `{ Authorization: "Bearer tok" }`;
      `shouldAttachToken("/api/v1/review-board/cards", "tok")` returns `true`;
      `shouldAttachToken("/api/v1/auth/sessions", "tok")` returns `false` (never attach to the login
      route itself); `shouldAttachToken("https://evil.example.com/x", "tok")` returns `false`
      (absolute third-party URL). Before implementation: `Error: Cannot find module
      '.../session-view'` — the file does not exist. Confirmed: `node --import tsx --test
      tests/auth-session-view.test.mjs` failed with `ERR_MODULE_NOT_FOUND` before GREEN.
- [x] RED (`apps/web/tests/smoke.test.mjs`, modified): its existing admin-secret-header assertions
      are removed; replaced with an assertion that every protected route carries `canActivate:
      [requireSession]` and the `login` route does not (structural readback — this suite has no
      TestBed/live navigation harness). Before implementation, the old admin-secret assertions still
      referenced `admin-secret-store.ts`, which this unit deleted — RED signal that the smoke suite
      still encoded the pre-change contract.
- [x] GREEN: Created `apps/web/src/app/auth/session-view.ts` (pure, D9's three exported functions),
      `session-store.ts` (`SessionStore` signal service: `setSession`, `clearSession`, `token()`,
      `isAuthenticated`, `displayName`), `session.interceptor.ts` (attaches `Authorization: Bearer
      <token>` only per `shouldAttachToken`; clears the store and routes to `/login` on a `401`),
      `session.guard.ts` (`requireSession` `CanActivateFn`), `auth-api-client.ts` (`login`,
      `logout`), `login-page.ts` (form using `loginFormIssues`, styled with the existing Scholarly
      Schematic tokens, redirect-target validated against open-redirect per OWASP). Wired
      `provideHttpClient(withInterceptors([sessionInterceptor]))` in `app.config.ts`; added the
      `login` route plus `canActivate: [requireSession]` on the other five routes in
      `app.routes.ts`. Deleted `admin/admin-secret-store.ts` and `AdminApiClient.withSecret`;
      dropped `resolveAdminSecretForRequest`/`canSendAdminRequest` from `admin-providers-view.ts`
      (kept `isAdminAuthError`/`extractAdminErrorMessage`, narrowed to the `401`-only shape D6
      implies — no `403` branch); removed the "NOT real authentication" UI copy and its `p[role=
      'note']` styles from `admin-providers-page.ts`.
- [x] TRIANGULATE: `shouldAttachToken` also refuses a relative URL that resolves outside `/api/`
      (e.g. a static asset path), not only the two named cases; `requireSession` on an
      already-authenticated session returns `true` without a redirect (no redirect loop — direct
      code path, no conditional redirect branch taken); the interceptor's `401`-triggered store
      clear is naturally idempotent (`clearSession()`/`router.navigate()` are both safe to call
      twice), so a second concurrent `401` cannot double-fire into an error.
- [x] REFACTOR: N/A — `session-view.ts` follows the existing `admin-providers-view.ts` pure-sibling
      precedent with no new pattern.
- [x] Verify: `pnpm --dir apps/web test` green (70/70, including `auth-session-view.test.mjs` and
      the updated `smoke.test.mjs`/`admin-providers-view.test.mjs`); `pnpm --dir apps/web build`
      compiles clean.
- [x] Rollback: **only valid together with reverting Unit 3a** — restore `admin-secret-store.ts` and
      `AdminApiClient.withSecret`; remove the `auth/*` directory and its route-guard/interceptor
      wiring from `app.config.ts`/`app.routes.ts`.

### 4. Attribution wiring: approval identity, uploader id, `?? 0` removal, audit actors

- [x] RED (`apps/api/tests/reviewer-auth-attribution.test.mjs`, real PG): approving a card with a
      forged `reviewerName: "Someone Else"` in the request body, while authenticated as reviewer
      "Dr. Ana Ruiz", persists `reviewer_name = "Dr. Ana Ruiz"` and `approved_by_reviewer_id` equal
      to that reviewer's id — the submitted body value never reaches the row. Before implementation:
      the persisted `reviewer_name` equals the forged `"Someone Else"` value (today's real,
      documented vulnerability) — the assertion fails against the actual pre-change behavior.
      Confirmed: failed with `expected 'Dr. Ana Ruiz', actual 'Someone Else'` before GREEN.
- [x] RED (same file): a session-authenticated upload persists `thesis_document.uploaded_by_user_id`
      equal to the session's real `reviewer_id`, and it is asserted `!== 0` explicitly (not just
      "truthy"). Before implementation: the column is hardcoded to `0` — the `!== 0` assertion
      fails. Confirmed: failed with `expected 0 to not strictly-equal 0` before GREEN.
- [x] RED (same file): calling the upload path's underlying function with `uploaderUserId: null`
      throws (loudly), rather than silently persisting `0`. Before implementation:
      `live-review-pipeline.mjs:296`'s `uploaderUserId ?? 0` swallows the null and returns
      normally — the "throws" assertion fails because nothing throws. Confirmed:
      `Missing expected rejection` before GREEN (tested both `null` and `undefined`).
- [x] RED (same file): approving a card and uploading a thesis each write an `audit_event` row
      (`card_approved`, `thesis_uploaded`) with `actor_user_id` equal to the acting reviewer's real
      id. Before implementation: zero such rows exist — these two event types are not yet emitted by
      `insertAuditEvent` (Unit 2 only wired the three login/logout events). Confirmed:
      `expected 1, actual 0` (zero `card_approved` rows) before GREEN.
- [x] GREEN: In `api-contract.mjs`'s approval handler, replaced `{ reviewerName: body.reviewerName
      ?? body.reviewer_name ?? null }` with `{ reviewerId: requestSession.reviewerId, reviewerName:
      requestSession.displayName }`, deleting the body-field reads outright (D8). In
      `review-repository.mjs`'s `approveReviewBoardCard`, changed
      `reviewer_name = COALESCE($2, reviewer_name)` to
      `reviewer_name = $2, approved_by_reviewer_id = $3` (new `reviewerId` param). In
      `api-contract.mjs`'s upload handler, replaced `uploaderUserId: body.uploaderUserId ?? null`
      with `uploaderUserId: requestSession.reviewerId`. In `live-review-pipeline.mjs`'s
      `registerUploadedDocument`, replaced `uploadedByUserId: uploaderUserId ?? 0` with
      `uploadedByUserId: uploaderUserId` plus an explicit throw (before any DB access) when
      `uploaderUserId` is null/undefined. Exported `auth-contract.mjs`'s existing
      `safeInsertAuditEvent` (previously private) and reused it — rather than duplicating its
      try/catch + cached-audit-repository logic — for two new call sites: `card_approved` (approval
      handler, `entityId` parsed from the `board_<id>` public card id) and `thesis_uploaded` (upload
      handler, `entityId` = the real persisted `thesis_document.id` returned by
      `registerUploadedDocument`). Also threaded the resolved `session` out of
      `checkRequestSession` (previously discarded the session, kept only the error) into a new
      `requestSession` variable available to both handlers.
- [x] TRIANGULATE: the thrown error from the null-`uploaderUserId` guard is caught upstream (proven
      directly: `postgres-unreachable.test.mjs`'s existing 503 path still exercises the same
      try/catch, and the new RED test asserts `assert.rejects`, i.e. a real rejected promise, never
      an unhandled one) and surfaced as a `5xx`/explicit error response by `api-contract.mjs`'s
      existing `try/catch` around `registerUploadedDocument`, not an unhandled rejection that
      crashes the process; a legacy row with `uploaded_by_user_id = 0` (pre-existing data) is left
      untouched by this change — no backfill runs (confirmed: the guard only fires on the call path,
      it never touches existing rows). Also confirmed by direct real-Postgres smoke test (see
      apply-progress): a session-authenticated approval with a forged body `reviewerName` persists
      the session's real display name and `approved_by_reviewer_id`, and the audit trail
      (`login_succeeded`, `thesis_uploaded`, `card_approved`) is attributed to the real reviewer id
      throughout.
- [x] REFACTOR: three call-site diffs plus two new `safeInsertAuditEvent` call sites, no new
      abstraction — reused the existing best-effort audit wrapper (exported it) instead of
      duplicating it, per the apply prompt's explicit instruction to check for reuse first.
      **Consequential test fix** (not a new feature): `live-review-integration.test.mjs`'s
      pre-existing approval assertion sent a forged `reviewerName: "Dr. Hopper"` body field and
      asserted the response echoed it back — exactly the vulnerability this unit closes. Updated
      the assertion to check against the authenticated session's real `displayName` instead, and
      additively exposed `displayName` from `reviewer-session-fixture.mjs`'s return value so the
      test could assert against it without hardcoding the fixture's default string twice.
- [x] Verify: `pnpm --dir apps/api test` green — 151/151 (147 pre-existing + 4 new attribution
      cases), including all four attribution cases and both new audit-actor cases. Real end-to-end
      smoke test also run directly against dockerized Postgres (see apply-progress "Work Unit
      Evidence" for the full transcript): login → upload (real `uploaded_by_user_id`, not `0`) →
      approve with a forged `reviewerName` body field → persisted `reviewer_name`/
      `approved_by_reviewer_id` and all three audit rows (`login_succeeded`, `thesis_uploaded`,
      `card_approved`) attributed to the real authenticated reviewer.
- [x] Rollback: revert the three call-site diffs, the `safeInsertAuditEvent` export, and the two new
      call sites; attribution columns return to their `0`/`NULL`/`COALESCE`-preserved defaults — no
      data loss, matching the proposal's documented rollback plan. The `live-review-integration.test.mjs`
      and `reviewer-session-fixture.mjs` updates would need to revert together with the
      `approveReviewBoardCard` signature change, since they assert against the new contract.

## Suggested PR Chain

**Chain strategy: feature-branch-chain**, chosen per delivery parameters specifically because of
D12's hard constraint — API enforcement (3a) must never reach `main` ahead of the Angular login
page (3b), or the deployed UI 401s on every screen. A stacked-to-main chain would let 3a merge to
`main` independently the moment it is approved; feature-branch-chain keeps the whole change off
`main` until the tracker merges, so the 3a/3b pairing can be enforced structurally, not by
review-time vigilance alone.

Branches:

```
feature/reviewer-authentication  (tracker — draft PR, no-merge until the end, targets `main`)
  └─ pr1/schema-auth-contract              (targets tracker)                    — Unit 1
       └─ pr2/login-logout-audit           (targets pr1/schema-auth-contract)   — Unit 2
            ├─ pr3a/api-session-enforcement (targets pr2/login-logout-audit)    — Unit 3a
            └─ pr3b/angular-auth            (targets pr2/login-logout-audit)    — Unit 3b
                 (both branch from the SAME point; reviewed in parallel; see joint-merge rule)
                 └─ pr4/attribution-wiring  (targets the post-joint-merge tip)  — Unit 4
```

1. **Tracker PR** (draft, no-merge): `feature/reviewer-authentication` → `main`. Opened first,
   stays open through the whole chain, carries the cumulative dependency diagram.
2. **PR1** (`pr1/schema-auth-contract` → tracker): Unit 1. Deployable alone (dormant). Merges into
   the tracker branch once approved.
3. **Manual gate** (not a PR): operator runs `seed-reviewer.mjs` against the environment tracking
