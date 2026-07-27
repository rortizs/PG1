import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

async function withFixtureMigrationsDir(fn) {
	const dir = await mkdtemp(join(tmpdir(), "migrate-fixture-"));
	try {
		return await fn(dir, pathToFileURL(`${dir}/`));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const BASELINE_TABLES = [
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

// Every table expected once ALL discovered migrations (0001 + 0002 + ...)
// have been applied via the default, no-args `migrateUp`/`migrateDown`.
const REQUIRED_TABLES = [...BASELINE_TABLES, "llm_provider_config"];

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
	"listMigrationFiles discovers ALL *.sql files in a directory and sorts them by filename (not a single hardcoded path)",
	async () => {
		const { listMigrationFiles } = await import("../src/db/migrate.mjs");

		await withFixtureMigrationsDir(async (dir, dirUrl) => {
			// Written deliberately out of order on disk to prove sorting, not
			// directory-listing order, determines the result.
			await writeFile(
				join(dir, "0002_second.sql"),
				"-- UP\nSELECT 1;\n-- DOWN\nSELECT 1;",
			);
			await writeFile(
				join(dir, "0001_first.sql"),
				"-- UP\nSELECT 1;\n-- DOWN\nSELECT 1;",
			);
			await writeFile(join(dir, "not-a-migration.txt"), "ignore me");

			const files = await listMigrationFiles(dirUrl);
			const names = files.map((fileUrl) => fileUrl.pathname.split("/").pop());

			assert.deepEqual(names, ["0001_first.sql", "0002_second.sql"]);
		});
	},
);

test(
	"migrate.mjs discovers and applies ALL *.sql files under a migrations directory in filename order, and reverts them in reverse order",
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
			await withFixtureMigrationsDir(async (dir, migrationsDir) => {
				// `fixture_b` FK-references `fixture_a`, so this genuinely proves
				// ordering both ways: UP must create `fixture_a` (0001) before
				// `fixture_b` (0002), and DOWN must drop `fixture_b` before
				// `fixture_a` — dropping in ascending (non-reversed) order would
				// fail here with a foreign-key-dependency error.
				await writeFile(
					join(dir, "0001_fixture_a.sql"),
					"-- UP\nCREATE TABLE migration_fixture_a (id INT PRIMARY KEY);\n-- DOWN\nDROP TABLE migration_fixture_a;",
				);
				await writeFile(
					join(dir, "0002_fixture_b.sql"),
					"-- UP\nCREATE TABLE migration_fixture_b (id INT PRIMARY KEY, a_id INT REFERENCES migration_fixture_a(id));\n-- DOWN\nDROP TABLE migration_fixture_b;",
				);

				await migrate.migrateUp({ client, migrationsDir });

				const tableRows = await client.query(
					`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('migration_fixture_a', 'migration_fixture_b') ORDER BY table_name`,
				);
				assert.deepEqual(
					tableRows.rows.map((row) => row.table_name),
					["migration_fixture_a", "migration_fixture_b"],
					"both fixture migrations must have applied in filename order",
				);

				await migrate.migrateDown({ client, migrationsDir });

				const tablesAfterDown = await client.query(
					`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('migration_fixture_a', 'migration_fixture_b')`,
				);
				assert.equal(
					tablesAfterDown.rows.length,
					0,
					"both fixture migrations must have reverted in reverse filename order",
				);
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"migrate.mjs applies and reverts ALL discovered migrations (baseline + llm_provider_config) in order against live Postgres",
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

test(
	"migrate.mjs: applying 0001 alone (via an explicit migrationPath) still creates exactly the baseline tables — no regression from auto-discovery",
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
			// Clean slate: revert everything (all discovered migrations), then
			// apply ONLY the 0001 baseline file via the single-file escape hatch.
			await migrate.migrateDown({ client }).catch(() => {});

			const baselinePath = new URL(
				"../src/db/migrations/0001_schema_baseline.sql",
				import.meta.url,
			);
			await migrate.migrateUp({ client, migrationPath: baselinePath });

			const tableRows = await client.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
			);
			const tableNames = tableRows.rows.map((row) => row.table_name);

			assert.deepEqual(
				[...tableNames].sort(),
				[...BASELINE_TABLES].sort(),
				"0001 applied alone must create exactly the baseline tables, no more, no fewer",
			);

			await migrate.migrateDown({ client, migrationPath: baselinePath });

			const tablesAfterDown = await client.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
			);
			assert.equal(tablesAfterDown.rows.length, 0);
		} finally {
			// Restore the full schema so subsequent tests in this file/suite
			// (which assume all migrations applied) are unaffected by this
			// single-file detour.
			await migrate.migrateUp({ client }).catch(() => {});
			await client.end();
		}
	},
);
