import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * reviewer-authentication PR1, Work Unit 1 (design.md D3-D5): pure functions
 * in `auth-contract.mjs`. No I/O, no DB — every assertion here calls
 * production code directly and checks a specific expected value.
 *
 * Before `auth-contract.mjs` exists, every import below throws at module
 * load time (`Cannot find module`) — the RED signal for this whole file.
 */

const authContract = await import("../src/auth-contract.mjs").catch(
	(error) => ({ __importError: error }),
);

function mod() {
	if (authContract.__importError) {
		throw authContract.__importError;
	}
	return authContract;
}

test("normalizeEmail: trims, lowercases, and rejects unusable input", () => {
	const { normalizeEmail } = mod();
	assert.equal(normalizeEmail(" Jane@Foo.COM "), "jane@foo.com");
	assert.equal(normalizeEmail("garbage"), "");
});

test("parseBearerToken: case-insensitive header lookup, rejects non-Bearer, extracts the token", () => {
	const { parseBearerToken } = mod();
	assert.equal(
		parseBearerToken({ Authorization: "Bearer abc123" }),
		"abc123",
	);
	assert.equal(
		parseBearerToken({ authorization: "Bearer abc123" }),
		"abc123",
	);
	assert.equal(parseBearerToken({}), null);
	assert.equal(parseBearerToken({ Authorization: "Basic xyz" }), null);
});

test("hashSessionToken: returns a deterministic 64-char lowercase hex digest", () => {
	const { hashSessionToken } = mod();
	const digest = hashSessionToken("some-opaque-token");
	assert.match(digest, /^[a-f0-9]{64}$/);
	assert.equal(digest, hashSessionToken("some-opaque-token"));
	assert.notEqual(digest, hashSessionToken("a-different-token"));
});

test("validatePasswordStrength: enforces the 12-128 character length bound", () => {
	const { validatePasswordStrength } = mod();
	const tooShort = validatePasswordStrength("a".repeat(11));
	assert.equal(tooShort.field, "password");
	assert.ok(tooShort.message.length > 0);

	const tooLong = validatePasswordStrength("a".repeat(129));
	assert.equal(tooLong.field, "password");

	assert.equal(validatePasswordStrength("a".repeat(12)), null);
	assert.equal(validatePasswordStrength("a".repeat(128)), null);
});

test("generateSessionToken: returns a token, its matching hash, and an expiry SESSION_TTL_MS in the future", () => {
	const { generateSessionToken, hashSessionToken, SESSION_TTL_MS } = mod();
	const now = new Date("2026-01-01T00:00:00.000Z");
	const { token, tokenHash, expiresAt } = generateSessionToken(now);

	assert.equal(typeof token, "string");
	assert.ok(token.length >= 32);
	assert.equal(tokenHash, hashSessionToken(token));
	assert.equal(expiresAt.getTime(), now.getTime() + SESSION_TTL_MS);
});

test("evaluateThrottle / nextThrottleState: 5 consecutive failures throttle, a 6th within the window is still throttled, success self-clears", () => {
	const { evaluateThrottle, nextThrottleState, FAILED_LOGIN_THRESHOLD } =
		mod();
	const now = new Date("2026-01-01T00:00:00.000Z");

	let state = { failedLoginCount: 0, throttledUntil: null };
	for (let i = 0; i < FAILED_LOGIN_THRESHOLD; i += 1) {
		assert.equal(evaluateThrottle(state, now), null);
		state = nextThrottleState(state, now, { succeeded: false });
	}

	const throttleError = evaluateThrottle(state, now);
	assert.equal(throttleError.status, 429);
	assert.ok(throttleError.body.details.retry_after_seconds > 0);

	// A 6th failure while still throttled: evaluateThrottle alone is checked
	// before any further nextThrottleState call in the real credential flow.
	const stillThrottledSameMoment = evaluateThrottle(state, now);
	assert.equal(stillThrottledSameMoment.status, 429);

	const clearedState = nextThrottleState(state, now, { succeeded: true });
	assert.deepEqual(clearedState, {
		failedLoginCount: 0,
		throttledUntil: null,
	});
	assert.equal(evaluateThrottle(clearedState, now), null);
});

test("evaluateThrottle: the throttle window itself expires with wall-clock time (self-clear, no operator intervention)", () => {
	const { evaluateThrottle, nextThrottleState, FAILED_LOGIN_THRESHOLD, THROTTLE_WINDOW_MS } =
		mod();
	const now = new Date("2026-01-01T00:00:00.000Z");

	let state = { failedLoginCount: 0, throttledUntil: null };
	for (let i = 0; i < FAILED_LOGIN_THRESHOLD; i += 1) {
		state = nextThrottleState(state, now, { succeeded: false });
	}
	assert.ok(evaluateThrottle(state, now) !== null);

	const afterWindow = new Date(now.getTime() + THROTTLE_WINDOW_MS + 1000);
	assert.equal(evaluateThrottle(state, afterWindow), null);
});

test("errorResponse shape parity: auth-contract's error bodies share admin-contract's { error, message, details, request_id, timestamp } shape", () => {
	const { evaluateThrottle, nextThrottleState, FAILED_LOGIN_THRESHOLD } =
		mod();
	const now = new Date("2026-01-01T00:00:00.000Z");
	let state = { failedLoginCount: 0, throttledUntil: null };
	for (let i = 0; i < FAILED_LOGIN_THRESHOLD; i += 1) {
		state = nextThrottleState(state, now, { succeeded: false });
	}
	const throttleError = evaluateThrottle(state, now);

	assert.deepEqual(Object.keys(throttleError.body).sort(), [
		"details",
		"error",
		"message",
		"request_id",
		"timestamp",
	]);
});
