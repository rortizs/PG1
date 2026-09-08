import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Follow-up coverage for spec scenario "Postgres unreachable -> 5xx"
 * (`vertical-slice-cag-review/spec.md`, Requirement: Explicit Failure
 * Handling). Unlike every other live-Postgres test in this suite (which
 * SKIPS when Postgres is unreachable, per `connectOrSkip` in
 * `live-review-integration.test.mjs` / `review-repository.test.mjs`), this
 * test is the inverse: it WANTS Postgres to be genuinely unreachable, so it
 * never skips on that condition — it asserts on it.
 *
 * Uses an unused local port (5555) rather than the default 5432, because on
 * this machine a local Homebrew `postgresql@17` service intercepts
 * `localhost:5432` ahead of Docker's forward, which would produce a
 * `role does not exist`/auth failure (Postgres IS reachable, just
 * misconfigured) instead of a genuine connection-refused condition. A
 * preflight probe below confirms the target port is truly unreachable
 * before trusting the real assertions, so this test fails loudly instead of
 * silently passing for the wrong reason if that assumption ever breaks.
 */
const UNREACHABLE_DATABASE_URL = "postgres://pg1:pg1@127.0.0.1:5555/pg1";
const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const reachableDatabaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

function pdfFile(name) {
	const content = Buffer.from(`%PDF-1.4 fake bytes for ${name}`);
	return {
		filename: name,
		contentType: "application/pdf",
		content,
		size: content.byteLength,
	};
}

function expectStandardError(response, status, error) {
	assert.equal(response.status, status);
	assert.deepEqual(Object.keys(response.body).sort(), [
		"details",
		"error",
		"message",
		"request_id",
		"timestamp",
	]);
	assert.equal(response.body.error, error);
	assert.equal(typeof response.body.message, "string");
}

test(
	"upload returns 503 service_unavailable when Postgres is genuinely unreachable (connection refused) — never a crash, never a silently-wrong success",
	async () => {
		// --- Preflight: prove the target port is genuinely unreachable first.
		// If this ever fails, the test below would be exercising the wrong
		// condition (e.g. some other service now listens on 5555) — fail loudly
		// here instead of letting the real assertions pass for the wrong reason.
		const { default: pg } = await import("pg");
		const probe = new pg.Client({
			connectionString: UNREACHABLE_DATABASE_URL,
			connectionTimeoutMillis: 2000,
		});
		let probeError = null;
		try {
			await probe.connect();
			await probe.end();
		} catch (error) {
			probeError = error;
		}
		assert.ok(
			probeError,
			"Precondition failed: expected 127.0.0.1:5555 to be unreachable so this test can exercise a genuine connection-refused case, but a connection succeeded. Pick a different unused port.",
		);
		assert.equal(
			probeError.code,
			"ECONNREFUSED",
			`Precondition failed: expected ECONNREFUSED on 127.0.0.1:5555, got ${probeError.code ?? probeError.message}`,
		);

		// reviewer-authentication PR3a: `POST /api/v1/thesis-documents` now sits
		// behind the deny-by-default session gate (design.md D6), which needs a
		// reachable database to verify ANY session. To keep exercising THIS
		// test's specific boundary (the upload path's own DB-unreachable
		// handling, not the auth gate's), a real reviewer session is minted
		// while `DATABASE_URL` is still reachable, and the auth gate is
		// deliberately "warmed" with one successful authenticated call — this
		// populates `auth-contract.mjs`'s cached reviewer-repository singleton
		// against the REACHABLE connection string, so once `DATABASE_URL` flips
		// to the unreachable target below, `checkSession` keeps succeeding
		// (same cached repository) while the upload's own — separately
		// resolved — DB write is what genuinely fails.
		const migrate = await import("../src/db/migrate.mjs");
		const setupClient = new pg.Client({
			connectionString: reachableDatabaseUrl,
			connectionTimeoutMillis: 2000,
		});
		await setupClient.connect();
		await migrate.migrateDown({ client: setupClient }).catch(() => {});
		await migrate.migrateUp({ client: setupClient });
		await setupClient.end();

		process.env.DATABASE_URL = reachableDatabaseUrl;
		const { createAuthenticatedSession } = await import(
			"./support/reviewer-session-fixture.mjs"
		);
		const session = await createAuthenticatedSession({
			connectionString: reachableDatabaseUrl,
		});

		const { handleApiRequest } = await import("../src/api-contract.mjs");
		const { _resetLiveReviewPipelineForTests } = await import(
			"../src/live-review-pipeline.mjs"
		);
		_resetLiveReviewPipelineForTests();

		// Warm-up call: proves the session gate itself works against the
		// reachable DB and populates the cached reviewer repository.
		const warmup = await handleApiRequest({
			method: "GET",
			path: "/api/v1/thesis-documents",
			headers: session.headers,
		});
		assert.equal(warmup.status, 200);

		// --- Real assertions: a genuinely unreachable DATABASE_URL during a
		// real upload must surface as 5xx with the standard error shape, not a
		// crash and not a silently-wrong 201 success.
		process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;

		try {
			const response = await handleApiRequest({
				method: "POST",
				path: "/api/v1/thesis-documents",
				body: { files: [pdfFile("unreachable-db.pdf")], uploaderUserId: 1 },
				headers: session.headers,
			});

			expectStandardError(response, 503, "service_unavailable");
			assert.match(response.body.message, /could not be durably persisted/i);
			assert.match(response.body.details.reason, /ECONNREFUSED/i);
		} finally {
			delete process.env.DATABASE_URL;
			_resetLiveReviewPipelineForTests();
			const cleanupClient = new pg.Client({ connectionString: reachableDatabaseUrl });
			await cleanupClient.connect();
			await migrate.migrateDown({ client: cleanupClient }).catch(() => {});
			await cleanupClient.end();
		}
	},
);
