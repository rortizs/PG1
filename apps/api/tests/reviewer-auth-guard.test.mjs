import { test } from "node:test";
import assert from "node:assert/strict";
import { UnauthorizedException, ServiceUnavailableException } from "@nestjs/common";

/**
 * reviewer-authentication PR3a (design.md D6): `SessionGuard` unit coverage
 * plus the two `handleApiRequest`-level cases the contract sweep in
 * `contract.test.mjs` does not itself cover — an expired/unknown token still
 * 401s a protected route, and a valid unexpired token actually reaches its
 * handler.
 *
 * Before this unit exists: no `headers` param is even threaded through
 * `handleApiRequest`, so a token cannot be presented to be checked at all —
 * `SessionGuard` itself does not exist (`Cannot find module
 * '.../session.guard.ts'`), and `handleApiRequest` silently drops any
 * `headers` a caller passes.
 */

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

/** Minimal fake `ExecutionContext` — `SessionGuard` only ever calls `switchToHttp().getRequest()`. */
function fakeExecutionContext(headers) {
	return {
		switchToHttp: () => ({
			getRequest: () => ({ headers }),
		}),
	};
}

async function connectOrSkip(t) {
	const { default: pg } = await import("pg");
	const client = new pg.Client({
		connectionString: databaseUrl,
		connectionTimeoutMillis: 2000,
	});
	try {
		await client.connect();
	} catch (error) {
		t.skip(
			`DATABASE_URL not reachable (${databaseUrl}) — start Docker Postgres via infra/docker-compose.yml to run this integration test: ${error.message}`,
		);
		return null;
	}
	return client;
}

async function resetSchemaToHead(client) {
	const migrate = await import("../src/db/migrate.mjs");
	await migrate.migrateDown({ client }).catch(() => {});
	await migrate.migrateUp({ client });
}

test("SessionGuard: no Authorization header throws UnauthorizedException", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;
	try {
		await resetSchemaToHead(client);
		process.env.DATABASE_URL = databaseUrl;
		const { SessionGuard } = await import("../src/auth/session.guard.ts");
		const guard = new SessionGuard();

		await assert.rejects(
			() => guard.canActivate(fakeExecutionContext({})),
			UnauthorizedException,
		);
	} finally {
		await client.end();
	}
});

test("SessionGuard: an unknown/never-issued token throws UnauthorizedException", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;
	try {
		await resetSchemaToHead(client);
		process.env.DATABASE_URL = databaseUrl;
		const { SessionGuard } = await import("../src/auth/session.guard.ts");
		const guard = new SessionGuard();

		await assert.rejects(
			() =>
				guard.canActivate(
					fakeExecutionContext({ Authorization: "Bearer totally-unknown-token" }),
				),
			UnauthorizedException,
		);
	} finally {
		await client.end();
	}
});

test("SessionGuard: a valid unexpired session token resolves to true (canActivate)", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;
	try {
		await resetSchemaToHead(client);
		process.env.DATABASE_URL = databaseUrl;
		const { SessionGuard } = await import("../src/auth/session.guard.ts");
		const { createAuthenticatedSession } = await import(
			"./support/reviewer-session-fixture.mjs"
		);
		const session = await createAuthenticatedSession({ connectionString: databaseUrl });
		const guard = new SessionGuard();

		const allowed = await guard.canActivate(
			fakeExecutionContext({ Authorization: `Bearer ${session.token}` }),
		);
		assert.equal(allowed, true);
	} finally {
		await client.end();
	}
});

test("SessionGuard: DATABASE_URL unset throws ServiceUnavailableException, never UnauthorizedException", async () => {
	const original = process.env.DATABASE_URL;
	delete process.env.DATABASE_URL;
	try {
		const { SessionGuard } = await import("../src/auth/session.guard.ts");
		const guard = new SessionGuard();

		await assert.rejects(
			() => guard.canActivate(fakeExecutionContext({})),
			ServiceUnavailableException,
		);
	} finally {
		if (original === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = original;
	}
});

test("handleApiRequest: an expired session token 401s a protected route", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;
	try {
		await resetSchemaToHead(client);
		process.env.DATABASE_URL = databaseUrl;

		const { hashPassword } = await import("../src/security/password-hasher.mjs");
		const { createReviewerRepository } = await import(
			"../src/db/reviewer-repository.mjs"
		);
		const { generateSessionToken } = await import("../src/auth-contract.mjs");
		const { handleApiRequest } = await import("../src/api-contract.mjs");

		const repository = createReviewerRepository({ connectionString: databaseUrl });
		const passwordHash = await hashPassword("expired-session-fixture-pass-1");
		const reviewer = await repository.createReviewer({
			email: "expired-session@example.com",
			passwordHash,
			displayName: "Expired Session Reviewer",
		});
		// `reviewer_session_expiry_order_check` requires `expires_at >
		// created_at` at INSERT time, so an already-past `expiresAt` cannot be
		// inserted directly — insert one that expires almost immediately
		// instead, then wait for it to genuinely lapse before calling the API.
		const { token, tokenHash } = generateSessionToken();
		const almostNow = new Date(Date.now() + 50);
		await repository.createSession({
			reviewerId: reviewer.id,
			tokenHash,
			expiresAt: almostNow,
		});
		await new Promise((resolve) => setTimeout(resolve, 150));

		const response = await handleApiRequest({
			method: "GET",
			path: "/api/v1/thesis-documents",
			headers: { Authorization: `Bearer ${token}` },
		});

		assert.equal(response.status, 401);
		assert.equal(response.body.error, "unauthorized");
	} finally {
		await client.end();
	}
});

test("handleApiRequest: a valid unexpired session token reaches the route's real handler", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;
	try {
		await resetSchemaToHead(client);
		process.env.DATABASE_URL = databaseUrl;

		const { handleApiRequest } = await import("../src/api-contract.mjs");
		const { createAuthenticatedSession } = await import(
			"./support/reviewer-session-fixture.mjs"
		);
		const session = await createAuthenticatedSession({ connectionString: databaseUrl });

		const response = await handleApiRequest({
			method: "GET",
			path: "/api/v1/thesis-documents",
			headers: session.headers,
		});

		assert.equal(response.status, 200);
		assert.ok(Array.isArray(response.body.items));
	} finally {
		await client.end();
	}
});

test("handleApiRequest: a deactivated reviewer session 401s protected routes immediately", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;
	try {
		await resetSchemaToHead(client);
		process.env.DATABASE_URL = databaseUrl;

		const { handleApiRequest } = await import("../src/api-contract.mjs");
		const { createReviewerRepository } = await import(
			"../src/db/reviewer-repository.mjs"
		);
		const { createAuthenticatedSession } = await import(
			"./support/reviewer-session-fixture.mjs"
		);
		const session = await createAuthenticatedSession({ connectionString: databaseUrl });
		const repository = createReviewerRepository({ connectionString: databaseUrl });
		await repository.setActive(session.reviewerId, false);

		const response = await handleApiRequest({
			method: "GET",
			path: "/api/v1/thesis-documents",
			headers: session.headers,
		});

		assert.equal(response.status, 401);
		assert.equal(response.body.error, "unauthorized");
	} finally {
		await client.end();
	}
});
