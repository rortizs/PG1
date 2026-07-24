import { test } from "node:test";
import assert from "node:assert/strict";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

const REQUIRED_TABLES = [
	"thesis_document",
	"review_run",
	"document_page",
	"document_section",
	"evidence_snippet",
	"finding",
	"finding_evidence",
	"report_artifact",
	"normative_source",
	"normative_segment",
	"embedding_record",
	"audit_event",
];

test("splitMigration parses -- UP and -- DOWN sections from raw SQL", async () => {
	const { splitMigration } = await import("../src/db/migrate.mjs");

	const sql = "-- UP\nCREATE TABLE a(id INT);\n-- DOWN\nDROP TABLE a;";
	const { up, down } = splitMigration(sql);

	assert.equal(up, "CREATE TABLE a(id INT);");
	assert.equal(down, "DROP TABLE a;");
});

test("splitMigration throws an explicit error when markers are missing", async () => {
	const { splitMigration } = await import("../src/db/migrate.mjs");

	assert.throws(
		() => splitMigration("CREATE TABLE a(id INT);"),
		/-- UP/,
	);
});

test(
	"migrate.mjs applies and reverts the baseline schema against live Postgres",
	async (t) => {
		let pg;
		let migrate;
		try {
			({ default: pg } = await import("pg"));
			migrate = await import("../src/db/migrate.mjs");
		} catch (error) {
			t.skip(`pg driver or migrate.mjs unavailable: ${error.message}`);
			return;
		}

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
			return;
		}

		try {
			// Ensure a clean slate regardless of leftover state from a previous run.
			await migrate.migrateDown({ client }).catch(() => {});

			await migrate.migrateUp({ client });

			const tableRows = await client.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
			);
			const tableNames = tableRows.rows.map((row) => row.table_name);

			for (const table of REQUIRED_TABLES) {
				assert.ok(
					tableNames.includes(table),
					`expected table "${table}" to exist after migrate up`,
				);
			}
			assert.equal(tableNames.length, REQUIRED_TABLES.length);

			const extensionRows = await client.query(
				`SELECT extname FROM pg_extension WHERE extname = 'vector'`,
			);
			assert.equal(extensionRows.rows.length, 1);

			await migrate.migrateDown({ client });

			const tablesAfterDown = await client.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
			);
			assert.equal(tablesAfterDown.rows.length, 0);

			const extensionAfterDown = await client.query(
				`SELECT extname FROM pg_extension WHERE extname = 'vector'`,
			);
			assert.equal(extensionAfterDown.rows.length, 0);
		} finally {
			await client.end();
		}
	},
);
