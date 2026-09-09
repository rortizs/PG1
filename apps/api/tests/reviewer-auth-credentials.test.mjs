import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * reviewer-authentication PR1, Work Unit 1 (design.md D3-D5): `verifyCredentials`
 * and `checkSession`, both exercised against an injected FAKE repository — no
 * DB, so `node --test` genuinely covers the auth decision logic without a
 * live Postgres.
 *
 * Before `auth-contract.mjs` exists, every import below throws
 * `Cannot find module` at load time — the RED signal for this whole file.
 */

const authContract = await import("../src/auth-contract.mjs").catch(
	(error) => ({ __importError: error }),
);
const passwordHasher = await import("../src/security/password-hasher.mjs").catch(
	(error) => ({ __importError: error }),
);

function mod() {
	if (authContract.__importError) throw authContract.__importError;
	return authContract;
}

function hasher() {
	if (passwordHasher.__importError) throw passwordHasher.__importError;
	return passwordHasher;
}

/** Minimal in-memory fake implementing only what verifyCredentials needs. */
function createFakeReviewerRepository({ reviewers = [] } = {}) {
	const byEmail = new Map(reviewers.map((r) => [r.email, { ...r }]));
	const sessionsByHash = new Map();

	return {
		async findByEmail(email) {
			return byEmail.get(email) ?? null;
		},
		async updateLoginState(reviewerId, { failedLoginCount, throttledUntil, lastLoginAt }) {
			for (const reviewer of byEmail.values()) {
				if (reviewer.id === reviewerId) {
					reviewer.failedLoginCount = failedLoginCount;
					reviewer.throttledUntil = throttledUntil;
					if (lastLoginAt !== undefined) reviewer.lastLoginAt = lastLoginAt;
				}
			}
		},
		async createSession({ reviewerId, tokenHash, expiresAt }) {
			sessionsByHash.set(tokenHash, { reviewerId, tokenHash, expiresAt, revokedAt: null });
		},
		async findSessionByHash(tokenHash) {
			const row = sessionsByHash.get(tokenHash);
			if (!row) return null;
			const reviewer = [...byEmail.values()].find((r) => r.id === row.reviewerId);
			return {
				sessionId: 1,
				reviewerId: row.reviewerId,
				expiresAt: row.expiresAt,
				revokedAt: row.revokedAt,
				email: reviewer?.email,
				displayName: reviewer?.displayName,
				isActive: reviewer?.isActive,
			};
		},
		_setSession(tokenHash, session) {
			sessionsByHash.set(tokenHash, session);
		},
	};
}

function maskVolatileFields(body) {
	const { request_id: _requestId, timestamp: _timestamp, ...rest } = body;
	return rest;
}

async function buildKnownReviewer() {
	const { hashPassword } = hasher();
	const passwordHash = await hashPassword("correct-horse-battery-staple");
	return {
		id: 1,
		email: "jane@foo.com",
		passwordHash,
		displayName: "Jane Doe",
		isActive: true,
		failedLoginCount: 0,
		throttledUntil: null,
		lastLoginAt: null,
	};
}

test("verifyCredentials: unknown email and wrong password for a known email return byte-identical error bodies", async () => {
	const { verifyCredentials, _resetAuthContractForTests } = mod();
	_resetAuthContractForTests?.();
	const reviewer = await buildKnownReviewer();
	const repository = createFakeReviewerRepository({ reviewers: [reviewer] });
	const now = new Date("2026-01-01T00:00:00.000Z");

	const unknownResult = await verifyCredentials({
		email: "nobody@foo.com",
		password: "irrelevant-password-12345",
		repository,
		now,
	});
	const wrongPasswordResult = await verifyCredentials({
		email: "jane@foo.com",
		password: "totally-wrong-password-12345",
		repository,
		now,
	});

	assert.equal(unknownResult.reviewer, null);
	assert.equal(wrongPasswordResult.reviewer, null);
	assert.deepEqual(
		maskVolatileFields(unknownResult.error.body),
		maskVolatileFields(wrongPasswordResult.error.body),
	);
	assert.equal(unknownResult.error.status, wrongPasswordResult.error.status);
});

test("verifyCredentials: an inactive account returns the same generic error body as a wrong password", async () => {
	const { verifyCredentials, _resetAuthContractForTests } = mod();
	_resetAuthContractForTests?.();
	const reviewer = await buildKnownReviewer();
	reviewer.isActive = false;
	const repository = createFakeReviewerRepository({ reviewers: [reviewer] });
	const now = new Date("2026-01-01T00:00:00.000Z");

	const inactiveResult = await verifyCredentials({
		email: "jane@foo.com",
		password: "correct-horse-battery-staple",
		repository,
		now,
	});
	const wrongPasswordResult = await verifyCredentials({
		email: "jane@foo.com",
		password: "totally-wrong-password-12345",
		repository,
		now,
	});

	assert.equal(inactiveResult.reviewer, null);
	assert.deepEqual(
		maskVolatileFields(inactiveResult.error.body),
		maskVolatileFields(wrongPasswordResult.error.body),
	);
});

test("verifyCredentials: a 6th failed attempt within the window returns 429 for both a known and an unknown email", async () => {
	const { verifyCredentials, FAILED_LOGIN_THRESHOLD, _resetAuthContractForTests } = mod();
	_resetAuthContractForTests?.();
	const reviewer = await buildKnownReviewer();
	const repository = createFakeReviewerRepository({ reviewers: [reviewer] });
	const now = new Date("2026-01-01T00:00:00.000Z");

	for (let i = 0; i < FAILED_LOGIN_THRESHOLD; i += 1) {
		await verifyCredentials({
			email: "jane@foo.com",
			password: "wrong-password-attempt",
			repository,
			now,
		});
	}
	const sixthKnown = await verifyCredentials({
		email: "jane@foo.com",
		password: "wrong-password-attempt",
		repository,
		now,
	});
	assert.equal(sixthKnown.error.status, 429);

	for (let i = 0; i < FAILED_LOGIN_THRESHOLD; i += 1) {
		await verifyCredentials({
			email: "ghost@foo.com",
			password: "wrong-password-attempt",
			repository,
			now,
		});
	}
	const sixthUnknown = await verifyCredentials({
		email: "ghost@foo.com",
		password: "wrong-password-attempt",
		repository,
		now,
	});
	assert.equal(sixthUnknown.error.status, 429);
});

test("verifyCredentials: an unknown email still burns one real argon2id verify against DUMMY_PASSWORD_HASH (timing parity, not a shortcut)", async () => {
	const { verifyCredentials, _resetAuthContractForTests } = mod();
	_resetAuthContractForTests?.();
	const repository = createFakeReviewerRepository({ reviewers: [] });
	const now = new Date("2026-01-01T00:00:00.000Z");

	// A pure-JS "unknown email -> instant reject" shortcut would resolve in
	// well under 1ms. A real argon2id verify against DUMMY_PASSWORD_HASH
	// (memoryCost: 19456) measurably does not — proving the burn actually
	// executed, not just that the function returned the right error shape.
	const start = process.hrtime.bigint();
	const result = await verifyCredentials({
		email: "nobody@foo.com",
		password: "irrelevant-password-12345",
		repository,
		now,
	});
	const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

	assert.equal(result.reviewer, null);
	assert.equal(result.error.status, 401);
	assert.ok(
		elapsedMs >= 3,
		`expected the unknown-email path to burn a real argon2id verify (>= 3ms), took ${elapsedMs}ms`,
	);
});

test("verifyCredentials: a success clears the stored failedLoginCount", async () => {
	const { verifyCredentials, _resetAuthContractForTests } = mod();
	_resetAuthContractForTests?.();
	const reviewer = await buildKnownReviewer();
	reviewer.failedLoginCount = 3;
	const repository = createFakeReviewerRepository({ reviewers: [reviewer] });
	const now = new Date("2026-01-01T00:00:00.000Z");

	const result = await verifyCredentials({
		email: "jane@foo.com",
		password: "correct-horse-battery-staple",
		repository,
		now,
	});

	assert.equal(result.error, null);
	assert.equal(result.reviewer.email, "jane@foo.com");
	assert.equal(result.reviewer.displayName, "Jane Doe");
	const persisted = await repository.findByEmail("jane@foo.com");
	assert.equal(persisted.failedLoginCount, 0);
	assert.equal(persisted.throttledUntil, null);
});

test("checkSession: a valid unexpired unrevoked session resolves to { session, error: null }", async () => {
	const { checkSession, generateSessionToken } = mod();
	const repository = createFakeReviewerRepository({
		reviewers: [
			{
				id: 7,
				email: "ana@foo.com",
				displayName: "Ana Ruiz",
				isActive: true,
				failedLoginCount: 0,
				throttledUntil: null,
			},
		],
	});
	const now = new Date("2026-01-01T00:00:00.000Z");
	const { token, tokenHash, expiresAt } = generateSessionToken(now);
	await repository.createSession({ reviewerId: 7, tokenHash, expiresAt });

	const result = await checkSession(
		{ Authorization: `Bearer ${token}` },
		{ repository, now },
	);

	assert.equal(result.error, null);
	assert.equal(result.session.reviewerId, 7);
	assert.equal(result.session.email, "ana@foo.com");
	assert.equal(result.session.displayName, "Ana Ruiz");
});

test("checkSession: an expired session, a revoked session, an unknown token, and a missing header all deny by default with a 401", async () => {
	const { checkSession, generateSessionToken } = mod();
	const repository = createFakeReviewerRepository({
		reviewers: [{ id: 7, email: "ana@foo.com", displayName: "Ana Ruiz", isActive: true }],
	});
	const now = new Date("2026-01-01T00:00:00.000Z");

	const expired = generateSessionToken(new Date(now.getTime() - 100000));
	repository._setSession(expired.tokenHash, {
		reviewerId: 7,
		tokenHash: expired.tokenHash,
		expiresAt: new Date(now.getTime() - 1000),
		revokedAt: null,
	});

	const revoked = generateSessionToken(now);
	repository._setSession(revoked.tokenHash, {
		reviewerId: 7,
		tokenHash: revoked.tokenHash,
		expiresAt: new Date(now.getTime() + 100000),
		revokedAt: now,
	});

	const expiredResult = await checkSession(
		{ Authorization: `Bearer ${expired.token}` },
		{ repository, now },
	);
	const revokedResult = await checkSession(
		{ Authorization: `Bearer ${revoked.token}` },
		{ repository, now },
	);
	const unknownResult = await checkSession(
		{ Authorization: "Bearer totally-unknown-token" },
		{ repository, now },
	);
	const missingHeaderResult = await checkSession({}, { repository, now });

	for (const result of [expiredResult, revokedResult, unknownResult, missingHeaderResult]) {
		assert.equal(result.session, null);
		assert.equal(result.error.status, 401);
	}
});

test("checkSession: revocation wins over a still-future expiry", async () => {
	const { checkSession, generateSessionToken } = mod();
	const repository = createFakeReviewerRepository({
		reviewers: [{ id: 7, email: "ana@foo.com", displayName: "Ana Ruiz", isActive: true }],
	});
	const now = new Date("2026-01-01T00:00:00.000Z");
	const { token, tokenHash } = generateSessionToken(now);
	repository._setSession(tokenHash, {
		reviewerId: 7,
		tokenHash,
		expiresAt: new Date(now.getTime() + 1000 * 60 * 60),
		revokedAt: now,
	});

	const result = await checkSession(
		{ Authorization: `Bearer ${token}` },
		{ repository, now },
	);
	assert.equal(result.session, null);
	assert.equal(result.error.status, 401);
});
