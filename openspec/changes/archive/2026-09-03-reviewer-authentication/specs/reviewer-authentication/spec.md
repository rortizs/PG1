# Reviewer Authentication Specification

## Purpose

Give PG1 real identity: named reviewer accounts, argon2id credential
verification, opaque DB-backed session tokens, and session-based route
protection across the API's non-login surface. Replaces the temporary
`ADMIN_SHARED_SECRET` gate and unauthenticated write access with an
authenticated-reviewer model — no student accounts, RBAC, SSO, or MFA.

## Requirements

### Requirement: Reviewer Account Credential Storage

The system MUST store reviewer accounts with argon2id-hashed passwords and
MUST NOT persist or log a plaintext password. Accounts MUST be provisioned
only via an operator-run seed/CLI command; the system MUST NOT expose a
self-registration endpoint.

#### Scenario: Operator provisions a reviewer account

- GIVEN an operator runs the account-provisioning CLI with an email and password
- WHEN the command completes
- THEN a `reviewer` row is persisted with an argon2id password hash
- AND the plaintext password is not stored or logged

#### Scenario: No public registration endpoint exists

- GIVEN the API route table
- WHEN a client requests a self-registration endpoint
- THEN no such route exists and the API returns `404`

### Requirement: Session-Issuing Login

The system MUST verify submitted credentials against the stored argon2id
hash and, on success, MUST issue an opaque, DB-backed session token with an
expiry. On failure the system MUST return a generic error that does not
reveal whether the email exists, and MUST throttle repeated failed attempts
for the same identifier, recording a failed-login audit event per attempt.

#### Scenario: Valid credentials issue a session

- GIVEN a provisioned reviewer account with a known password
- WHEN the reviewer submits correct email and password to the login endpoint
- THEN the system returns a session token
- AND a corresponding `reviewer_session` row exists with a future `expires_at`

#### Scenario: Invalid credentials return a generic error

- GIVEN a login request with a wrong password, or an email that does not exist
- WHEN the request is submitted
- THEN both cases return the same `401` response shape
- AND no response detail distinguishes "wrong password" from "unknown email"

#### Scenario: Repeated failures are throttled

- GIVEN N consecutive failed login attempts for the same identifier within the throttle window
- WHEN one more attempt is submitted
- THEN the system returns `429` without evaluating the credentials
- AND a failed-login audit event is recorded for each attempt

### Requirement: Session Validation on Protected Routes

Every route under `/api/v1/thesis-documents`, `/api/v1/review-runs`,
`/api/v1/review-board`, and `/api/v1/admin` MUST require a valid, unexpired
session token, following the same 401-on-missing/invalid pattern as the
retired `checkAdminSecretHeader` gate (`apps/api/src/admin-contract.mjs`).
Unlike that gate, the system MUST NOT return a separate `403` for a
present-but-wrong credential, since no distinct admin role exists — any
authenticated reviewer has the access this gate protected.

#### Scenario: Request without a session token is rejected

- GIVEN a request to any protected route with no `Authorization` header
- WHEN the request is submitted
- THEN the system returns `401 unauthorized`
- AND no data is read, created, or modified

#### Scenario: Request with an expired or unknown token is rejected

- GIVEN a request bearing a token that is expired or matches no `reviewer_session` row
- WHEN the request is submitted
- THEN the system returns `401 unauthorized`

#### Scenario: Request with a valid session proceeds

- GIVEN a request bearing a token matching an unexpired `reviewer_session` row
- WHEN the request is submitted
- THEN the guard allows the request to reach its handler

### Requirement: Server-Side Logout

Logout MUST invalidate the session server-side (delete or expire the
`reviewer_session` row), not merely instruct the client to discard the
token.

#### Scenario: Logout invalidates the session

- GIVEN a reviewer holds a valid session token
- WHEN the reviewer calls the logout endpoint
- THEN the corresponding `reviewer_session` row is deleted or marked expired

#### Scenario: A logged-out token no longer authorizes requests

- GIVEN a session token was invalidated by logout
- WHEN that same token is used on a protected route
- THEN the system returns `401 unauthorized`
