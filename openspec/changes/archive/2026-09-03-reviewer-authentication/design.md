# Design: Reviewer Authentication

> Size note: this design exceeds the 800-word budget, following the house exception set by
> `precise-thesis-review-pipeline/design.md` and `thesis-normative-governance/design.md`. The
> change spans a schema migration, a new pure contract module, a NestJS guard, an Angular auth
> surface and an operator CLI; exact SQL, signatures and the runnable script are the artifact's
> value. Prose is minimized to tables and code.

## Technical Approach

Identity becomes a **request-scoped fact resolved once, at the edge, from a server-owned
record** — never a client-supplied string. A reviewer exchanges credentials for an opaque
random token; only its SHA-256 digest is stored. Every protected request carries
`Authorization: Bearer <token>`; the pure `checkSession()` resolves it to a `session` object,
and every attribution write (`reviewer_name`, `uploaded_by_user_id`, `actor_user_id`) reads
that object, so a forged body field has nothing to forge into.

Enforcement is duplicated exactly like today's admin gate: `SessionGuard` at the HTTP boundary
(defense in depth) and `checkSession()` inside `handleApiRequest` (the sole path exercised by
`node --test`, since no supertest layer exists).

```
POST /api/v1/auth/sessions ──► verifyCredentials() ──► argon2id verify ──► reviewer_session row
   (public)                          │                                          │
                                 throttle policy                          token (once, in body)
                                                                                │
Angular SessionStore (signal, in-memory only) ◄─────────────────────────────────┘
   │  sessionInterceptor: Authorization: Bearer <token>
   ▼
SessionGuard ──► checkSession(headers) ──► { session } ──► handleApiRequest branches
                        │                       │
                        └── 401 (deny by default)└──► approveReviewBoardCard({ reviewerId, reviewerName })
                                                 ├──► registerUploadedDocument({ uploaderUserId })
                                                 └──► insertAuditEvent({ actorUserId })
```

## Architecture Decisions

### D1 — Migration `0007_reviewer_authentication.sql`

Two additive tables plus one additive column. No FK is added to the legacy
`thesis_document.uploaded_by_user_id` (out of scope: `0` stays "pre-auth, unattributed").

```sql
-- UP
-- reviewer-authentication design.md D1: named reviewer accounts. `email` is stored
-- already-normalized (`normalizeEmail()` in auth-contract.mjs lowercases + trims); the CHECK
-- enforces that invariant in the schema, so no insert path (seed CLI, a future admin CRUD)
-- can create a case-variant duplicate identity that would silently split one human in two.
CREATE TABLE reviewer (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  password_hash TEXT NOT NULL CHECK (btrim(password_hash) <> ''),
  display_name TEXT NOT NULL CHECK (btrim(display_name) <> ''),
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- D5: throttle-only policy. `throttled_until` self-clears with wall time; there is no
  -- hard lock and no operator-intervention state, per the confirmed lockout decision.
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  throttled_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- D4: only the SHA-256 digest of the opaque token is ever stored. A dump of this table
-- yields no usable credential; the `~ '^[a-f0-9]{64}$'` CHECK mirrors
-- `thesis_document.sha256`'s existing convention and makes "someone stored the raw token"
-- structurally impossible rather than merely reviewed-against.
CREATE TABLE reviewer_session (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reviewer_id BIGINT NOT NULL REFERENCES reviewer(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reviewer_session_expiry_order_check CHECK (expires_at > created_at)
);

-- D8: unforgeable approval attribution. Nullable and never backfilled — historical rows keep
-- their free-text `reviewer_name` and a NULL id, which is the honest record of "approved
-- before identity existed" (confirmed: no backfill).
ALTER TABLE review_workflow_item
  ADD COLUMN approved_by_reviewer_id BIGINT REFERENCES reviewer(id);

CREATE INDEX idx_reviewer_session_reviewer_id ON reviewer_session(reviewer_id);
CREATE INDEX idx_reviewer_session_expires_at ON reviewer_session(expires_at);
CREATE INDEX idx_review_workflow_item_approved_by_reviewer_id
  ON review_workflow_item(approved_by_reviewer_id);

-- DOWN
-- Reverse order: the FK column referencing `reviewer` must go before `reviewer` itself,
-- and `reviewer_session` before `reviewer`, or the DROPs fail on dependent objects.
DROP INDEX IF EXISTS idx_review_workflow_item_approved_by_reviewer_id;
ALTER TABLE review_workflow_item DROP COLUMN IF EXISTS approved_by_reviewer_id;
DROP TABLE IF EXISTS reviewer_session;
DROP TABLE IF EXISTS reviewer;
```

`token_hash UNIQUE` supplies its own lookup index — no separate `idx_..._token_hash`.
`is_active` is not a role (roles stay out of scope): with password reset out of scope it is
the **only** lever an operator has to kill a leaked credential without deleting audit history.

### D2 — Password hashing: argon2id, with a **pure-JS** fallback (not bcrypt)

| Option | Tradeoff | Decision |
|---|---|---|
| **`argon2` (argon2id)** | Native addon; ships prebuilt binaries for linux/darwin x64+arm64 | **Chosen** — OWASP's first recommendation, memory-hard, tunable |
| `bcrypt` | **Also a native node-gyp addon**, so it does not mitigate the failure mode the proposal names it for; silently truncates passwords at 72 bytes | **Rejected as the fallback** |
| `node:crypto` `scrypt` | Slightly weaker GPU resistance than argon2id; zero dependencies, zero build step, memory-hard, OWASP-accepted | **Chosen as the fallback** |

Parameters (OWASP minimum): `{ type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }`.

**Fallback trigger condition, stated falsifiably**: switch if a clean
`pnpm install --frozen-lockfile` inside the API's CI job or the `infra/` image build fails to
resolve a prebuilt `argon2` binary and requires a node-gyp/python toolchain. Then swap to
`scrypt` (`N=2^17, r=8, p=1`, 16-byte random salt, 32-byte key) — **not** bcrypt, because
bcrypt is the same class of native addon and would reproduce the exact failure.

The swap costs one file and **no migration**: all hashing lives behind
`apps/api/src/security/password-hasher.mjs` (sibling of the existing
`security/provider-key-cipher.mjs`), and the stored string is self-describing — argon2's own
PHC output `$argon2id$v=19$m=19456,t=2,p=1$…` or `$scrypt$N=131072,r=8,p=1$<salt>$<key>`.
`password_hash TEXT` holds either.

```js
// apps/api/src/security/password-hasher.mjs
export async function hashPassword(plaintext)          // -> PHC-encoded string
export async function verifyPassword(plaintext, hash)  // -> boolean; NEVER throws (bad hash => false)
export const DUMMY_PASSWORD_HASH                       // D5: fixed hash burned for unknown emails
```

### D3 — `auth-contract.mjs`: pure module, mirroring `admin-contract.mjs`

Isolated module + lazy cached repository + `errorResponse()` + `_reset…ForTests()` — the same
five structural moves as `admin-contract.mjs` (design decision #7 precedent), so
`contract.test.mjs` stays byte-untouched and auth is unit-testable without a live Nest app.

```js
// apps/api/src/auth-contract.mjs
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;      // one working day
export const FAILED_LOGIN_THRESHOLD = 5;
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;                  // OWASP: length only, no composition rules
export const MAX_PASSWORD_LENGTH = 128;

// --- pure, no I/O -----------------------------------------------------------
export function normalizeEmail(value)                   // -> string ("" when unusable)
export function validatePasswordStrength(password)      // -> null | { field, message }
export function parseBearerToken(headers)               // -> string | null (case-insensitive header
                                                        //    lookup, identical to lookupHeader())
export function hashSessionToken(token)                 // -> 64-char lowercase hex
export function generateSessionToken(now = new Date())  // -> { token, tokenHash, expiresAt }
export function evaluateThrottle(state, now)            // -> null | errorResponse(429, …)
export function nextThrottleState(state, now, { succeeded })
                                                        // -> { failedLoginCount, throttledUntil }

// --- async, repository-injected --------------------------------------------
export async function verifyCredentials({ email, password, repository, now })
export async function checkSession(headers, { repository, now })
export async function handleAuthRequest({ method, path, body, headers })
export function _resetAuthContractForTests()
```

**Return shapes.** `checkAdminSecretHeader` returns `null` on success — verified by reading it;
that shape cannot carry an identity. `checkSession` therefore returns a **two-key object with
both keys always present**, so callers never branch on shape:

```js
// success
{ session: { reviewerId: 3, sessionId: 12, email: "…", displayName: "…", expiresAt: "…" }, error: null }
// failure — `error` is byte-identical in shape to admin-contract's errorResponse()
{ session: null, error: { status: 401,
    body: { error: "unauthorized", message: "A valid reviewer session is required.",
            details: {}, request_id: "req_auth_contract", timestamp: "…" } } }
```

Call site: `const { session, error } = await checkSession(headers, { repository });
if (error) return error;`

`verifyCredentials` mirrors it: `{ reviewer: { id, email, displayName }, error: null }` or
`{ reviewer: null, error: <401|429> }`.

Rejected: keeping the literal `null | response` shape and stashing the session on a mutable
argument — it makes the function impure and untestable, which defeats the whole reason the
admin gate was written this way.

### D4 — Opaque token lifecycle

`randomBytes(32).toString("base64url")` (43 chars, 256 bits). Returned **once**, in the login
response body; the digest goes to the DB. Lookup is `WHERE token_hash = $1` — a digest
comparison against a `UNIQUE` index, so no timing-safe compare is needed (the attacker cannot
influence the digest of a guess incrementally). Validity = row exists **and**
`revoked_at IS NULL` **and** `expires_at > now()`. Logout sets `revoked_at = now()` →
revocation is instant, with no token-blacklist cache to keep coherent. Expired rows are left in
place (audit value); a cleanup job is a follow-up, not this change.

### D5 — Throttle: one pure policy, two storage backends

`evaluateThrottle`/`nextThrottleState` are pure functions over `{ failedLoginCount,
throttledUntil }`. After `FAILED_LOGIN_THRESHOLD` consecutive failures, `throttledUntil =
now + THROTTLE_WINDOW_MS` and the counter resets; a success clears both. Self-clearing, so no
operator intervention — exactly the confirmed "throttle only" policy.

**Enumeration closure.** A 429-for-existing-account vs 401-for-unknown-email differential is
itself an enumeration oracle. Unknown emails therefore get the *same* policy through a
process-local bounded bucket (`Map`, ≤1000 entries, LRU-evicted, cleared by
`_resetAuthContractForTests()`); known accounts get it through the `reviewer` row. Both call
the identical pure functions, so the two paths cannot drift. Additionally, an unknown email
still burns one `verifyPassword(password, DUMMY_PASSWORD_HASH)` so response time does not
distinguish. Accepted limits: buckets die on restart (they are a timing/enumeration defense,
not the primary control) and are per-process (single Nest process in `docker-compose`; no Redis
is introduced).

### D6 — `SessionGuard` + threading `headers` through `handleApiRequest`

```ts
// apps/api/src/auth/session.guard.ts — same shape as AdminSecretGuard, async because the
// session lives in Postgres, not an env var.
@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const { error } = await checkSession(request.headers ?? {}, {});
    if (!error) return true;
    if (error.status === 401) throw new UnauthorizedException(error.body);
    throw new ServiceUnavailableException(error.body);   // 503: DATABASE_URL unset
  }
}
```

There is no `403` branch: with no admin role, "wrong secret" has no analogue — every
authenticated reviewer is authorized for every route, exactly as confirmed.

`handleApiRequest({ method, path, query, body, headers = {} })` gains `headers` and runs the
gate **once, at the top, after the two public auth branches** — deny-by-default, so a route
added later is protected by omission rather than by remembering. Controllers add
`@Headers() headers` and `@UseGuards(SessionGuard)`, copying `admin.controller.ts` verbatim.

### D7 — Login/logout endpoint contract

Added to `api-contract.mjs`'s `ROUTES` table (so `listApiRoutes()` reports them), with the
handler body delegated to `auth-contract.mjs` — the same isolation split the admin routes use.

| Route | Gate | Request | Success | Failure |
|---|---|---|---|---|
| `POST /api/v1/auth/sessions` | public | `{ email, password }` | `201 { type: "reviewer_session", token, expires_at, reviewer: { id, email, display_name } }` | `422 validation_error` (blank field), `401 unauthorized` + `invalid_credentials` (generic — same body for unknown email, wrong password, inactive account), `429 too_many_attempts` + `details.retry_after_seconds`, `503 service_unavailable` |
| `DELETE /api/v1/auth/sessions/current` | public, idempotent | `Authorization: Bearer …` | `204` (empty body) | `503` only |

Logout stays **outside** the gate and always answers `204`, revoking the row only when the
digest matches. A gated logout would answer `401` for an already-expired token — a needless
oracle and a worse UX for the exact case it exists to serve.

### D8 — Attribution: three call sites, one source

| Call site | Today | After |
|---|---|---|
| `api-contract.mjs:154` | `{ reviewerName: body.reviewerName ?? body.reviewer_name ?? null }` | `{ reviewerId: session.reviewerId, reviewerName: session.displayName }` — the body fields are **deleted, not ignored**, so nothing can silently re-read them |
| `review-repository.mjs:576-587` | `reviewer_name = COALESCE($2, reviewer_name)` | `reviewer_name = $2, approved_by_reviewer_id = $3` — `COALESCE`'s "keep the old value" branch is dead once a session is mandatory |
| `api-contract.mjs:53` | `uploaderUserId: body.uploaderUserId ?? null` | `uploaderUserId: session.reviewerId` |
| `live-review-pipeline.mjs:296` | `uploadedByUserId: uploaderUserId ?? 0` | `uploadedByUserId: uploaderUserId` + a throw when null — the `?? 0` default is what made unattributed rows possible; it must fail loudly, not silently |

**Finding that changes the proposal's assumption:** `audit_event` has **zero writers anywhere
in `apps/api/src`** (verified by grep — it appears only in `0001_schema_baseline.sql` and two
migration tests). "Populate `actor_user_id`" therefore is not a wiring change; the writer must
be created. Scope it minimally:

```js
// review-repository.mjs — new, alongside the other insert helpers
async insertAuditEvent({ actorUserId = null, entityType, entityId = null, eventType,
                         message = null, metadata = {} })
```

Emitted for exactly five events: `login_succeeded`, `login_failed`, `logout`, `card_approved`,
`thesis_uploaded`. `login_failed` carries `actor_user_id = NULL` for an unknown email (writing
a resolved id would turn the audit log into the enumeration oracle the login response
refuses to be) and **never** the submitted password. Every audit write is best-effort inside
`try/catch` — an audit failure must never convert a successful approval into a request error.
Automated pipeline events stay unattributed (explicitly out of scope).

### D9 — Angular: signal store, functional interceptor, functional guard

Mirrors `admin-secret-store.ts` (in-memory signal, never persisted) and the existing
`admin-providers-view.ts` precedent of parking pure logic in a `*-view.ts` sibling so it is
testable without a TestBed.

```ts
// apps/web/src/app/auth/session-view.ts — pure, no Angular imports
export function loginFormIssues(email: string, password: string): string[]
export function buildAuthorizationHeader(token: string): Record<string, string>
export function shouldAttachToken(url: string, token: string | null): boolean

// apps/web/src/app/auth/session-store.ts
export interface ReviewerSession {
  token: string; reviewerId: number; email: string; displayName: string; expiresAt: string;
}
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly session = signal<ReviewerSession | null>(null);
  readonly isAuthenticated = computed(() => this.session() !== null);
  readonly displayName = computed(() => this.session()?.displayName ?? null);
  setSession(session: ReviewerSession): void
  clearSession(): void
  token(): string | null
}

// apps/web/src/app/auth/session.interceptor.ts
export const sessionInterceptor: HttpInterceptorFn = (req, next) => { … }
// Attaches `Authorization: Bearer <token>` only when shouldAttachToken(req.url, token) — i.e.
// same-origin `/api/` paths, never the login route and never an absolute third-party URL
// (a blanket interceptor is how bearer tokens leak to analytics/CDN hosts). On a 401 it
// clears the store and routes to /login, so a revoked session cannot loop silently.

// apps/web/src/app/auth/session.guard.ts
export const requireSession: CanActivateFn = (route, state) =>
  inject(SessionStore).isAuthenticated()
    ? true
    : inject(Router).createUrlTree(['/login'], { queryParams: { redirectTo: state.url } });

// apps/web/src/app/auth/auth-api-client.ts
login(email: string, password: string): Observable<ReviewerSession>
logout(): Observable<void>
```

Wiring: `provideHttpClient(withInterceptors([sessionInterceptor]))` in `app.config.ts`;
`{ path: 'login', component: LoginPage }` plus `canActivate: [requireSession]` on the other
five routes in `app.routes.ts`. `AdminSecretStore` and `AdminApiClient.withSecret()` are
deleted — `AdminApiClient` keeps its four methods and simply stops passing headers, because
the interceptor now supplies them.

### D10 — Operator provisioning CLI

Invocation matches `migrate.mjs` exactly (bare `node`, `DATABASE_URL` from the environment, an
`isMainModule` guard, `process.exitCode` on error) — no new `package.json` script, because
`migrate.mjs` has none and that is the house precedent.

```bash
# create (password generated, printed once, never echoed again)
DATABASE_URL=postgres://… node apps/api/src/db/seed-reviewer.mjs \
  --email jane.doe@umg.edu.gt --display-name "Jane Doe" --generate

# create with an operator-chosen password (read from stdin, NEVER argv)
REVIEWER_PASSWORD='…' DATABASE_URL=… node apps/api/src/db/seed-reviewer.mjs \
  --email jane.doe@umg.edu.gt --display-name "Jane Doe"

DATABASE_URL=… node apps/api/src/db/seed-reviewer.mjs --email jane.doe@umg.edu.gt --reset-password --generate
DATABASE_URL=… node apps/api/src/db/seed-reviewer.mjs --email jane.doe@umg.edu.gt --deactivate
```

```js
// apps/api/src/db/seed-reviewer.mjs
export function parseSeedArgs(argv)   // pure -> { email, displayName, mode, generate } | { error }
export async function seedReviewer({ connectionString, email, displayName, password, mode })
```

Rules, each with a reason:
- **`--password <value>` is rejected with an explicit error**, never accepted. Argv is visible
  in `ps` and lands in shell history; a flag that "works" would be used.
- Password source order: `--generate` (32 random base64url chars) → `REVIEWER_PASSWORD` →
  a stdin read (echo suppressed when stdin is a TTY).
- `validatePasswordStrength()` from `auth-contract.mjs` is reused, so the CLI and the API can
  never disagree about what a valid password is.
- Creating an existing email fails with "reviewer already exists — use `--reset-password`"
  rather than silently overwriting an account.
- The generated password prints **once**, to stdout, on its own line, prefixed so it is
  obvious it must be handed over out-of-band. The hash is never printed.

### D11 — Retiring the shared secret

Delete: `apps/api/src/admin/admin-secret.guard.ts`, `checkAdminSecretHeader` +
`constantTimeEquals` in `admin-contract.mjs` (the module survives — it still owns provider
CRUD), `apps/api/tests/admin-contract.test.mjs`'s secret cases,
`apps/web/src/app/admin/admin-secret-store.ts`, `AdminApiClient.withSecret`, the
`resolveAdminSecretForRequest`/`canSendAdminRequest` helpers in `admin-providers-view.ts`,
the "NOT real authentication" UI copy in `admin-providers-page.ts`, the `apps/web/tests/
smoke.test.mjs` assertions, and the runbook section in `docs/mvp-vertical-slice-runbook.md`.
Grep confirms `ADMIN_SHARED_SECRET` exists in **no** compose file or `.env` — only code and
that one doc — so "appears nowhere in the codebase or environment" is fully reachable.

### D12 — Rollout sequencing (feeds `sdd-tasks`' slicing)

The hard ordering constraint: **API enforcement must never reach `main` ahead of the Angular
login page**, or the deployed UI 401s on every screen. Within a Feature Branch Chain that is a
*merge* constraint, not a re-slicing — intermediate slices target the tracker branch.

| # | Slice | Gate state at end | Deployable alone |
|---|---|---|---|
| 1 | Migration `0007`, `password-hasher.mjs`, pure `auth-contract.mjs`, reviewer/session repository methods, seed CLI | none (dormant) | Yes — zero behavior change |
