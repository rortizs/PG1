import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * reviewer-authentication PR1, Work Unit 1 (design.md D1):
 * `0007_reviewer_authentication.sql` creates `reviewer`, `reviewer_session`,
 * and `review_workflow_item.approved_by_reviewer_id`, each with the CHECK
 * constraints that make an invalid stored value structurally impossible.
 *
 * Before this migration exists, every assertion below fails for the same
 * real reason: `relation "reviewer" does not exist` (or the equivalent for
 * `reviewer_session`) — the CHECK-violation assertions cannot even be
 * exercised because the table itself is absent.
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

async function migrateUpToBaseline(migrate, client) {
	const allFiles = await migrate.listMigrationFiles();
	const baselineFiles = allFiles.filter(
		(url) => !url.pathname.endsWith("0007_reviewer_authentication.sql"),
	);
	for (const migrationPath of baselineFiles) {
		await migrate.migrateUp({ client, migrationPath });
	}
}

async function apply0007(migrate, client) {
	// Constructed directly (not discovered via listMigrationFiles()) so a
	// missing migration file fails with a specific ENOENT, and an existing
	// one is applied in isolation — never silently falling back to
	// "re-run every migration" when the target file cannot be found.
	const migrationPath = new URL(
		"0007_reviewer_authentication.sql",
		migrate.MIGRATIONS_DIR,
	);
	await migrate.migrateUp({ client, migrationPath });
	return migrationPath;
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

test("0007_reviewer_authentication migration: UP creates reviewer, reviewer_session, and the FK column", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrateUpToBaseline(migrate, client);
		await apply0007(migrate, client);

		const tableRows = await client.query(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_schema = 'public' AND table_name IN ('reviewer', 'reviewer_session')
			 ORDER BY table_name`,
		);
		assert.deepEqual(
			tableRows.rows.map((row) => row.table_name),
			["reviewer", "reviewer_session"],
		);

		const columnRow = await client.query(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'review_workflow_item' AND column_name = 'approved_by_reviewer_id'`,
		);
		assert.equal(columnRow.rows.length, 1);
	} finally {
		await resetSchema(client);
		await client.end();
	}
});

test("0007_reviewer_authentication migration: a case-variant email is rejected by the CHECK", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrateUpToBaseline(migrate, client);
		await apply0007(migrate, client);

		await assert.rejects(
			client.query(
				`INSERT INTO reviewer (email, password_hash, display_name)
				 VALUES ('Jane@Foo.com', '$argon2id$fake', 'Jane Doe')`,
			),
			/reviewer_email_check|check constraint/i,
		);
	} finally {
		await resetSchema(client);
		await client.end();
	}
});

test("0007_reviewer_authentication migration: a non-hex token_hash is rejected by the CHECK", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrateUpToBaseline(migrate, client);
		await apply0007(migrate, client);

		const reviewerRow = await client.query(
			`INSERT INTO reviewer (email, password_hash, display_name)
			 VALUES ('jane@foo.com', '$argon2id$fake', 'Jane Doe') RETURNING id`,
		);

		await assert.rejects(
			client.query(
				`INSERT INTO reviewer_session (reviewer_id, token_hash, expires_at)
				 VALUES ($1, 'not-a-digest', now() + interval '1 hour')`,
				[reviewerRow.rows[0].id],
			),
			/reviewer_session_token_hash_check|check constraint/i,
		);

		// TRIANGULATE: a 31-hex-char string (too short, not merely non-hex)
		// proves the regex's exact 64-char length bound, not just presence of
		// *a* hex string.
		await assert.rejects(
			client.query(
				`INSERT INTO reviewer_session (reviewer_id, token_hash, expires_at)
				 VALUES ($1, 'deadbeef', now() + interval '1 hour')`,
				[reviewerRow.rows[0].id],
			),
			/reviewer_session_token_hash_check|check constraint/i,
		);
	} finally {
		await resetSchema(client);
		await client.end();
	}
});

test("0007_reviewer_authentication migration: expires_at <= created_at is rejected by reviewer_session_expiry_order_check", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrateUpToBaseline(migrate, client);
		await apply0007(migrate, client);

		const reviewerRow = await client.query(
			`INSERT INTO reviewer (email, password_hash, display_name)
			 VALUES ('jane@foo.com', '$argon2id$fake', 'Jane Doe') RETURNING id`,
		);
		const validHash = "a".repeat(64);

		await assert.rejects(
			client.query(
				`INSERT INTO reviewer_session (reviewer_id, token_hash, expires_at, created_at)
				 VALUES ($1, $2, now() - interval '1 hour', now())`,
				[reviewerRow.rows[0].id, validHash],
			),
			/reviewer_session_expiry_order_check/i,
		);
	} finally {
		await resetSchema(client);
		await client.end();
	}
});

test("0007_reviewer_authentication migration: UP then DOWN cycles cleanly", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrateUpToBaseline(migrate, client);
		const migrationPath = await apply0007(migrate, client);

		await migrate.migrateDown({ client, migrationPath });

		const tableRows = await client.query(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_schema = 'public' AND table_name IN ('reviewer', 'reviewer_session')`,
		);
		assert.equal(tableRows.rows.length, 0);

		const columnRow = await client.query(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'review_workflow_item' AND column_name = 'approved_by_reviewer_id'`,
		);
		assert.equal(columnRow.rows.length, 0);

		// Cycling UP a second time must succeed cleanly (no leftover state).
		await apply0007(migrate, client);
		const tableRowsAgain = await client.query(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_schema = 'public' AND table_name IN ('reviewer', 'reviewer_session')`,
		);
		assert.equal(tableRowsAgain.rows.length, 2);
	} finally {
		await resetSchema(client);
		await client.end();
	}
});
