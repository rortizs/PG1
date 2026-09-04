import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * reviewer-authentication PR1, Work Unit 1 (design.md D10): `seed-reviewer.mjs`
 * — `parseSeedArgs` is pure (no I/O); `seedReviewer` is exercised against
 * real Postgres (dockerized, per `infra/docker-compose.yml`).
 *
 * Before `seed-reviewer.mjs` exists, every import below throws
 * `Cannot find module` — the RED signal for the pure-function tests. The
 * integration test below reports the same class of failure explicitly.
 */

const seedModule = await import("../src/db/seed-reviewer.mjs").catch(
	(error) => ({ __importError: error }),
);

function mod() {
	if (seedModule.__importError) throw seedModule.__importError;
	return seedModule;
}

test("parseSeedArgs: --password is always rejected, never returned as a usable password", () => {
	const { parseSeedArgs } = mod();
	const result = parseSeedArgs([
		"--email",
		"jane@foo.com",
		"--display-name",
		"Jane Doe",
		"--password",
		"leaked-via-ps",
	]);
	assert.ok(result.error);
	assert.equal(result.password, undefined);
	assert.doesNotMatch(result.error, /leaked-via-ps/);
});

test("parseSeedArgs: a missing --email returns an error", () => {
	const { parseSeedArgs } = mod();
	const result = parseSeedArgs(["--display-name", "Jane Doe"]);
	assert.ok(result.error);
});

test("parseSeedArgs: --generate combined with --reset-password returns a valid combined-mode object", () => {
	const { parseSeedArgs } = mod();
	const result = parseSeedArgs([
		"--email",
		"jane@foo.com",
		"--reset-password",
		"--generate",
	]);
	assert.equal(result.error, undefined);
	assert.equal(result.email, "jane@foo.com");
	assert.equal(result.mode, "reset-password");
	assert.equal(result.generate, true);
});

// --- Integration (real Postgres) -------------------------------------------

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

async function resetSchema(client) {
	await client
		.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
		.catch(() => {});
	// Restore the full head schema so later ambient-state-dependent tests
	// (e.g. upload-storage.test.mjs) are unaffected by this file's detours —
	// same precedent as migrate-runner.test.mjs's own cleanup.
	const migrate = await import("../src/db/migrate.mjs");
	await migrate.migrateUp({ client }).catch(() => {});
}

async function migrateToHead(migrate, client) {
	const allFiles = await migrate.listMigrationFiles();
	for (const migrationPath of allFiles) {
		await migrate.migrateUp({ client, migrationPath });
	}
}

test("seedReviewer: --generate creates a logging-in reviewer; re-running the same email fails without overwriting", async (t) => {
	if (seedModule.__importError) {
		throw seedModule.__importError;
	}

	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrateToHead(migrate, client);

		const { seedReviewer } = mod();
		const generatedPassword = "GeneratedForTest-1234567890!!";

		const created = await seedReviewer({
			connectionString: databaseUrl,
			email: "seed-test@example.com",
			displayName: "Seed Test",
			password: generatedPassword,
			mode: "create",
		});
		assert.ok(created.id);
		assert.equal(created.email, "seed-test@example.com");

		const authContract = await import("../src/auth-contract.mjs");
		const { createReviewerRepository } = await import(
			"../src/db/reviewer-repository.mjs"
		);
		const repository = createReviewerRepository({ client });

		const loginResult = await authContract.verifyCredentials({
			email: "seed-test@example.com",
			password: generatedPassword,
			repository,
			now: new Date(),
		});
		assert.equal(loginResult.error, null);
		assert.equal(loginResult.reviewer.email, "seed-test@example.com");

		await assert.rejects(
			seedReviewer({
				connectionString: databaseUrl,
				email: "seed-test@example.com",
				displayName: "Seed Test Again",
				password: "AnotherPassword-1234567890!!",
				mode: "create",
			}),
			/already exists/i,
		);
	} finally {
		await resetSchema(client);
		await client.end();
	}
});
