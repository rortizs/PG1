import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * reviewer-authentication PR2, Work Unit 2 (design.md D7-D8):
 * `POST`/`DELETE /api/v1/auth/sessions[...]` wired into `handleApiRequest`,
 * delegating to `auth-contract.mjs`'s `handleAuthRequest`, plus the
 * `insertAuditEvent` writer for `login_succeeded`/`login_failed`/`logout`.
 *
 * Before this unit exists, `handleApiRequest` has no branch for
 * `/api/v1/auth/sessions` — every request below falls through to the
 * existing "unknown route" 404 branch, so every assertion below observes
 * `404` instead of its expected status. The audit-event assertions observe
 * zero rows in `audit_event`, because `insertAuditEvent` does not exist yet.
 */

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

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

async function createReviewer(client, { email, password, displayName = "Test Reviewer" }) {
	const { hashPassword } = await import("../src/security/password-hasher.mjs");
	const passwordHash = await hashPassword(password);
	const result = await client.query(
		`INSERT INTO reviewer (email, password_hash, display_name)
		 VALUES ($1, $2, $3) RETURNING id`,
		[email, passwordHash, displayName],
	);
	return Number(result.rows[0].id);
}

async function findSessionByToken(client, token) {
	const { hashSessionToken } = await import("../src/auth-contract.mjs");
	const tokenHash = hashSessionToken(token);
	const result = await client.query(
		`SELECT reviewer_id, revoked_at FROM reviewer_session WHERE token_hash = $1`,
		[tokenHash],
	);
	return result.rows[0] ?? null;
}

async function auditEventsByType(client, eventType) {
	const result = await client.query(
		`SELECT actor_user_id, entity_type, entity_id, event_type
		 FROM audit_event WHERE event_type = $1 ORDER BY id`,
		[eventType],
	);
	return result.rows.map((row) => ({
		actorUserId: row.actor_user_id === null ? null : Number(row.actor_user_id),
		entityType: row.entity_type,
		entityId: row.entity_id === null ? null : Number(row.entity_id),
		eventType: row.event_type,
	}));
}

/** Sets/deletes several env vars for the duration of `fn`, then restores them. */
async function withEnv(overrides, fn) {
	const previous = {};
	for (const key of Object.keys(overrides)) {
		previous[key] = process.env[key];
		if (overrides[key] === undefined) delete process.env[key];
		else process.env[key] = overrides[key];
	}
	try {
		return await fn();
	} finally {
		for (const key of Object.keys(previous)) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
}

async function freshAuthModules() {
	const apiContract = await import("../src/api-contract.mjs");
	const authContract = await import("../src/auth-contract.mjs");
	authContract._resetAuthContractForTests();
	return { handleApiRequest: apiContract.handleApiRequest, listApiRoutes: apiContract.listApiRoutes };
}

test(
	"reviewer auth routes: listApiRoutes reports both new routes",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);
			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { listApiRoutes } = await freshAuthModules();
				const routes = listApiRoutes().map((route) => `${route.method} ${route.path}`);
				assert.ok(
					routes.includes("POST /api/v1/auth/sessions"),
					"listApiRoutes() must report POST /api/v1/auth/sessions",
				);
				assert.ok(
					routes.includes("DELETE /api/v1/auth/sessions/current"),
					"listApiRoutes() must report DELETE /api/v1/auth/sessions/current",
				);
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"POST /api/v1/auth/sessions: a blank field returns 422 validation_error",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);
			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { handleApiRequest } = await freshAuthModules();
				const response = await handleApiRequest({
					method: "POST",
					path: "/api/v1/auth/sessions",
					body: { email: "", password: "" },
				});
				assert.equal(response.status, 422);
				assert.equal(response.body.error, "validation_error");
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"POST /api/v1/auth/sessions: a non-object body is validated the same as a missing one, never a 500 (TRIANGULATE: malformed body)",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);
			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { handleApiRequest } = await freshAuthModules();
				const response = await handleApiRequest({
					method: "POST",
					path: "/api/v1/auth/sessions",
					body: "not-an-object",
				});
				assert.equal(response.status, 422);
				assert.equal(response.body.error, "validation_error");
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"POST /api/v1/auth/sessions: valid credentials return 201 with a matching reviewer_session row and a login_succeeded audit event",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);
			const reviewerId = await createReviewer(client, {
				email: "jane@foo.com",
				password: "correct-horse-battery-staple",
			});

			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { handleApiRequest } = await freshAuthModules();
				const response = await handleApiRequest({
					method: "POST",
					path: "/api/v1/auth/sessions",
					body: { email: "jane@foo.com", password: "correct-horse-battery-staple" },
				});

				assert.equal(response.status, 201);
				assert.equal(response.body.type, "reviewer_session");
				assert.equal(typeof response.body.token, "string");
				assert.ok(response.body.token.length > 0);
				assert.match(response.body.expires_at, /^\d{4}-\d{2}-\d{2}T/);
				assert.deepEqual(response.body.reviewer, {
					id: reviewerId,
					email: "jane@foo.com",
					display_name: "Test Reviewer",
				});

				const sessionRow = await findSessionByToken(client, response.body.token);
				assert.ok(sessionRow, "a reviewer_session row must exist for the issued token");
				assert.equal(Number(sessionRow.reviewer_id), reviewerId);
				assert.equal(sessionRow.revoked_at, null);

				const succeededEvents = await auditEventsByType(client, "login_succeeded");
				assert.equal(succeededEvents.length, 1);
				assert.equal(succeededEvents[0].actorUserId, reviewerId);
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"POST /api/v1/auth/sessions: invalid credentials for a known email return 401 and a login_failed audit event with the reviewer's real id",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);
			const reviewerId = await createReviewer(client, {
				email: "jane@foo.com",
				password: "correct-horse-battery-staple",
			});

			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { handleApiRequest } = await freshAuthModules();
				const response = await handleApiRequest({
					method: "POST",
					path: "/api/v1/auth/sessions",
					body: { email: "jane@foo.com", password: "totally-wrong-password" },
				});

				assert.equal(response.status, 401);
				assert.equal(response.body.error, "unauthorized");

				const failedEvents = await auditEventsByType(client, "login_failed");
				assert.equal(failedEvents.length, 1);
				assert.equal(failedEvents[0].actorUserId, reviewerId);
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"POST /api/v1/auth/sessions: an unknown email returns 401 and writes login_failed with a NULL actor_user_id (no enumeration oracle in the audit log)",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);

			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { handleApiRequest } = await freshAuthModules();
				const response = await handleApiRequest({
					method: "POST",
					path: "/api/v1/auth/sessions",
					body: { email: "nobody@foo.com", password: "irrelevant-password-12345" },
				});

				assert.equal(response.status, 401);
				assert.equal(response.body.error, "unauthorized");

				const failedEvents = await auditEventsByType(client, "login_failed");
				assert.equal(failedEvents.length, 1);
				assert.equal(
					failedEvents[0].actorUserId,
					null,
					"an unknown email must never write a guessed actor_user_id",
				);
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"POST /api/v1/auth/sessions: the 6th rapid failed attempt returns 429 with details.retry_after_seconds",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);
			await createReviewer(client, {
				email: "jane@foo.com",
				password: "correct-horse-battery-staple",
			});

			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { handleApiRequest } = await freshAuthModules();
				let last;
				for (let i = 0; i < 6; i += 1) {
					last = await handleApiRequest({
						method: "POST",
						path: "/api/v1/auth/sessions",
						body: { email: "jane@foo.com", password: "wrong-password-attempt" },
					});
				}
				assert.equal(last.status, 429);
				assert.equal(typeof last.body.details.retry_after_seconds, "number");
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"DELETE /api/v1/auth/sessions/current: revokes a valid token, is idempotent on replay, and writes exactly one logout audit event",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);
			const reviewerId = await createReviewer(client, {
				email: "jane@foo.com",
				password: "correct-horse-battery-staple",
			});

			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { handleApiRequest } = await freshAuthModules();
				const login = await handleApiRequest({
					method: "POST",
					path: "/api/v1/auth/sessions",
					body: { email: "jane@foo.com", password: "correct-horse-battery-staple" },
				});
				assert.equal(login.status, 201);
				const token = login.body.token;

				const firstLogout = await handleApiRequest({
					method: "DELETE",
					path: "/api/v1/auth/sessions/current",
					headers: { Authorization: `Bearer ${token}` },
				});
				assert.equal(firstLogout.status, 204);

				const sessionRow = await findSessionByToken(client, token);
				assert.ok(sessionRow.revoked_at, "revoked_at must be set after logout");

				const secondLogout = await handleApiRequest({
					method: "DELETE",
					path: "/api/v1/auth/sessions/current",
					headers: { Authorization: `Bearer ${token}` },
				});
				assert.equal(
					secondLogout.status,
					204,
					"a replayed (already-revoked) token must still answer 204 — idempotent, never 401",
				);

				const logoutEvents = await auditEventsByType(client, "logout");
				assert.equal(
					logoutEvents.length,
					1,
					"a replayed logout on an already-revoked token must not write a second audit row",
				);
				assert.equal(logoutEvents[0].actorUserId, reviewerId);
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"DELETE /api/v1/auth/sessions/current: a token that was never issued still returns 204 and writes no logout audit row (TRIANGULATE: no existence oracle)",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);

			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { handleApiRequest } = await freshAuthModules();
				const before = await auditEventsByType(client, "logout");

				const response = await handleApiRequest({
					method: "DELETE",
					path: "/api/v1/auth/sessions/current",
					headers: { Authorization: "Bearer totally-unknown-token-value" },
				});
