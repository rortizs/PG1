import { createHash, randomBytes } from "node:crypto";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "./security/password-hasher.mjs";
import { createReviewerRepository } from "./db/reviewer-repository.mjs";
import { createReviewRepository } from "./db/review-repository.mjs";

/**
 * reviewer-authentication design.md D3-D5, D7: pure request-scoped identity
 * resolution plus the login/logout route-handler layer, mirroring
 * `admin-contract.mjs`'s isolation split (design decision #7) — isolated
 * module, `errorResponse()` helper, and a `_reset…ForTests()` escape hatch.
 */

const ROUTES = [
	["POST", "/api/v1/auth/sessions"],
	["DELETE", "/api/v1/auth/sessions/current"],
];

export function listAuthRoutes() {
	return ROUTES.map(([method, path]) => ({ method, path }));
}

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one working day
export const FAILED_LOGIN_THRESHOLD = 5;
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12; // OWASP: length only, no composition rules
export const MAX_PASSWORD_LENGTH = 128;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

// design.md D5 (enumeration closure): a process-local, bounded, LRU-evicted
// bucket tracking throttle state for emails that do NOT resolve to a real
// `reviewer` row, so an unknown email is throttled through the exact same
// pure policy as a known account — the two paths cannot drift because both
// call `evaluateThrottle`/`nextThrottleState` directly.
const UNKNOWN_EMAIL_BUCKET_MAX_ENTRIES = 1000;
let unknownEmailThrottleBuckets = new Map();

function bucketKey(email) {
	return String(email ?? "").trim().toLowerCase();
}

function getUnknownEmailBucketState(email) {
	const key = bucketKey(email);
	const state = unknownEmailThrottleBuckets.get(key);
	if (!state) return { failedLoginCount: 0, throttledUntil: null };
	// Touch for LRU: re-insert so this key is "most recently used".
	unknownEmailThrottleBuckets.delete(key);
	unknownEmailThrottleBuckets.set(key, state);
	return state;
}

function setUnknownEmailBucketState(email, state) {
	const key = bucketKey(email);
	unknownEmailThrottleBuckets.delete(key);
	unknownEmailThrottleBuckets.set(key, state);
	while (unknownEmailThrottleBuckets.size > UNKNOWN_EMAIL_BUCKET_MAX_ENTRIES) {
		const oldestKey = unknownEmailThrottleBuckets.keys().next().value;
		unknownEmailThrottleBuckets.delete(oldestKey);
	}
}

// --- pure, no I/O ------------------------------------------------------------

/** Trims + lowercases `value`; returns `""` when the result is not email-shaped. */
export function normalizeEmail(value) {
	const normalized = String(value ?? "").trim().toLowerCase();
	return EMAIL_PATTERN.test(normalized) ? normalized : "";
}

/** Length-only strength check (OWASP: composition rules are not required). */
export function validatePasswordStrength(password) {
	const length = typeof password === "string" ? password.length : 0;
	if (typeof password !== "string" || length < MIN_PASSWORD_LENGTH) {
		return {
			field: "password",
			message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
		};
	}
	if (length > MAX_PASSWORD_LENGTH) {
		return {
			field: "password",
			message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
		};
	}
	return null;
}

/**
 * Case-insensitive `Authorization` header lookup (mirrors
 * `admin-contract.mjs`'s `lookupHeader()`), extracting the token from a
 * `Bearer <token>` value. Returns `null` for a missing header or any
 * non-Bearer scheme (e.g. `Basic ...`).
 */
export function parseBearerToken(headers) {
	if (!headers) return null;
	const lowerName = "authorization";
	let value;
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lowerName) {
			value = headers[key];
			break;
		}
	}
	if (typeof value !== "string") return null;
	const match = value.match(/^Bearer\s+(\S+)$/i);
	return match ? match[1] : null;
}

/** SHA-256 digest of an opaque session token, as 64-char lowercase hex. */
export function hashSessionToken(token) {
	return createHash("sha256").update(String(token)).digest("hex");
}

/**
 * design.md D4: a fresh opaque session token, its digest (the only thing
 * ever persisted), and its expiry `SESSION_TTL_MS` from `now`.
 */
export function generateSessionToken(now = new Date()) {
	const token = randomBytes(32).toString("base64url");
	return {
		token,
		tokenHash: hashSessionToken(token),
		expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
	};
}

/**
 * `null` when the request may proceed; otherwise a `429 too_many_attempts`
 * `errorResponse` carrying `details.retry_after_seconds`.
 */
export function evaluateThrottle(state, now) {
	const throttledUntil = state?.throttledUntil ? new Date(state.throttledUntil) : null;
	if (!throttledUntil || throttledUntil.getTime() <= now.getTime()) return null;
	const retryAfterSeconds = Math.ceil((throttledUntil.getTime() - now.getTime()) / 1000);
	return errorResponse(
		429,
		"too_many_attempts",
		"Too many failed login attempts. Try again later.",
		{ retry_after_seconds: retryAfterSeconds },
	);
}

/**
 * design.md D5: after `FAILED_LOGIN_THRESHOLD` consecutive failures, throttle
 * for `THROTTLE_WINDOW_MS` and reset the counter (self-clearing — no
 * operator intervention). A success clears both fields.
 */
export function nextThrottleState(state, now, { succeeded }) {
	if (succeeded) {
		return { failedLoginCount: 0, throttledUntil: null };
	}
	const nextCount = (state?.failedLoginCount ?? 0) + 1;
	if (nextCount >= FAILED_LOGIN_THRESHOLD) {
		return {
			failedLoginCount: 0,
			throttledUntil: new Date(now.getTime() + THROTTLE_WINDOW_MS),
		};
	}
	return { failedLoginCount: nextCount, throttledUntil: state?.throttledUntil ?? null };
}

// --- async, repository-injected ----------------------------------------------

function invalidCredentialsError() {
	return errorResponse(
		401,
		"unauthorized",
		"The email or password is not valid.",
		{},
	);
}

/**
 * Verifies `{ email, password }` against `repository.findByEmail()`.
 * Unknown email, wrong password, an inactive account, and a throttled
 * account all resolve through the identical pure throttle policy and the
 * byte-identical `invalidCredentialsError()` body (OWASP A07 — no
 * enumeration oracle). Returns `{ reviewer, error: null }` on success or
 * `{ reviewer: null, error }` otherwise.
 */
export async function verifyCredentials({ email, password, repository, now = new Date() }) {
	const normalizedEmail = normalizeEmail(email);
	const reviewer = normalizedEmail ? await repository.findByEmail(normalizedEmail) : null;

	if (reviewer) {
		const state = {
			failedLoginCount: reviewer.failedLoginCount ?? 0,
			throttledUntil: reviewer.throttledUntil ?? null,
		};
		const throttleError = evaluateThrottle(state, now);
		if (throttleError) return { reviewer: null, error: throttleError };

		const passwordValid = await verifyPassword(password, reviewer.passwordHash);
		const succeeded = passwordValid && reviewer.isActive === true;
		const nextState = nextThrottleState(state, now, { succeeded });
		await repository.updateLoginState(reviewer.id, {
			failedLoginCount: nextState.failedLoginCount,
			throttledUntil: nextState.throttledUntil,
			lastLoginAt: succeeded ? now : undefined,
		});

		if (!succeeded) return { reviewer: null, error: invalidCredentialsError() };
		return {
			reviewer: { id: reviewer.id, email: reviewer.email, displayName: reviewer.displayName },
			error: null,
		};
	}

	// Unknown email: identical throttle policy via the bounded bucket, plus a
	// burned verifyPassword() call so response timing carries no signal.
	const bucketState = getUnknownEmailBucketState(email);
	const throttleError = evaluateThrottle(bucketState, now);
	if (throttleError) return { reviewer: null, error: throttleError };

	await verifyPassword(password, DUMMY_PASSWORD_HASH);
	const nextState = nextThrottleState(bucketState, now, { succeeded: false });
	setUnknownEmailBucketState(email, nextState);

	return { reviewer: null, error: invalidCredentialsError() };
}

/**
 * Resolves `Authorization: Bearer <token>` to a `session` via
 * `repository.findSessionByHash()`. Deny by default: a missing/malformed
 * header, an unknown token, a revoked session, or an expired session all
 * return the same 401 shape. Revocation wins over a still-future expiry.
 */
export async function checkSession(headers, { repository, now = new Date() }) {
	const token = parseBearerToken(headers);
	if (!token) return { session: null, error: sessionRequiredError() };

	const tokenHash = hashSessionToken(token);
	const row = await repository.findSessionByHash(tokenHash);
	if (!row) return { session: null, error: sessionRequiredError() };

	if (row.revokedAt) return { session: null, error: sessionRequiredError() };

	const expiresAt = new Date(row.expiresAt);
	if (expiresAt.getTime() <= now.getTime()) {
		return { session: null, error: sessionRequiredError() };
	}

	return {
		session: {
			reviewerId: row.reviewerId,
			sessionId: row.sessionId,
			email: row.email,
			displayName: row.displayName,
			expiresAt: row.expiresAt,
		},
		error: null,
	};
}

function sessionRequiredError() {
	return errorResponse(
		401,
		"unauthorized",
		"A valid reviewer session is required.",
		{},
	);
}

// --- route-handler layer (D7), delegating to the pure/repository-injected ---
// --- functions above, mirroring admin-contract.mjs's lazy-cached-repository
// --- pattern (design decision #7).

let cachedReviewerRepository;
let cachedAuditRepository;

function databaseUrl() {
	return process.env.DATABASE_URL || null;
}

function getReviewerRepository() {
	const connectionString = databaseUrl();
	if (!connectionString) return { error: "database_not_configured" };
	if (!cachedReviewerRepository) {
		cachedReviewerRepository = createReviewerRepository({ connectionString });
	}
	return { repository: cachedReviewerRepository };
}

/**
 * reviewer-authentication design.md D6: resolves the reviewer repository, or
 * a standard-shaped `503 service_unavailable` `errorResponse` when
 * `DATABASE_URL` is unset — shared by `SessionGuard` and `handleApiRequest`'s
 * top-level session gate, both of which need to source a repository for
 * `checkSession` themselves. `checkSession` (Unit 1, already tested) takes an
 * explicitly injected `repository` and never resolves one on its own — this
 * export is purely additive, zero changes to `checkSession`'s own logic.
 */
export function resolveReviewerRepository() {
	const resolved = getReviewerRepository();
	if (resolved.error) return { error: serviceUnavailableError() };
	return { repository: resolved.repository };
}

/**
 * `insertAuditEvent` (D8) lives on `review-repository.mjs`'s repository —
 * a different persistence surface than `reviewer-repository.mjs`. Lazily
 * cached the same way, and `null` (never an error) when `DATABASE_URL` is
 * unset, so callers can treat "no audit repository available" as just
 * another best-effort-skip case.
 */
function getAuditRepository() {
	const connectionString = databaseUrl();
	if (!connectionString) return null;
	if (!cachedAuditRepository) {
		cachedAuditRepository = createReviewRepository({ connectionString });
	}
	return cachedAuditRepository;
}

/**
 * design.md D8: every audit write is best-effort inside `try/catch` — an
 * audit-write failure must never convert a successful request into an
 * error response. Exported (Unit 4) so `api-contract.mjs`'s approval/upload
 * call sites can reuse the exact same best-effort wrapper and cached-audit-
 * repository resolution instead of duplicating it.
 */
export async function safeInsertAuditEvent(fields) {
	try {
		const repository = getAuditRepository();
		if (!repository) return;
		await repository.insertAuditEvent(fields);
	} catch {
		// Best-effort only — swallow deliberately (see doc comment above).
	}
}

function serviceUnavailableError() {
	return errorResponse(
		503,
		"service_unavailable",
		"The auth API requires DATABASE_URL to be configured.",
		{},
	);
}

/**
 * `POST /api/v1/auth/sessions` (public): validates `{ email, password }`,
 * delegates to `verifyCredentials`, and on success mints a fresh session
 * token via `generateSessionToken` + `repository.createSession`. Writes
 * `login_succeeded`/`login_failed` audit events (D8) — `login_failed` for
 * an unknown email carries a NULL `actorUserId`, resolved via a second
 * `findByEmail` lookup that never affects the (enumeration-safe) response
 * body, only the server-side audit trail.
 */
async function handleLogin({ body }) {
	const email = body?.email;
	const password = body?.password;
	const issues = [];
	if (typeof email !== "string" || email.trim() === "") {
		issues.push({ field: "email", message: "Must be a non-empty string." });
	}
	if (typeof password !== "string" || password.trim() === "") {
		issues.push({ field: "password", message: "Must be a non-empty string." });
	}
	if (issues.length) {
		return errorResponse(422, "validation_error", "Request validation failed.", {
			issues,
		});
	}

	const resolved = getReviewerRepository();
	if (resolved.error) return serviceUnavailableError();
	const repository = resolved.repository;
	const now = new Date();

	const { reviewer, error } = await verifyCredentials({ email, password, repository, now });
	if (error) {
		const normalizedEmail = normalizeEmail(email);
		const knownReviewer = normalizedEmail
			? await repository.findByEmail(normalizedEmail)
			: null;
		await safeInsertAuditEvent({
			actorUserId: knownReviewer ? knownReviewer.id : null,
			entityType: "reviewer",
			entityId: knownReviewer ? knownReviewer.id : null,
			eventType: "login_failed",
		});
		return error;
	}

	const { token, tokenHash, expiresAt } = generateSessionToken(now);
	await repository.createSession({ reviewerId: reviewer.id, tokenHash, expiresAt });

	await safeInsertAuditEvent({
