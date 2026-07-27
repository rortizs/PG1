import { test } from "node:test";
import assert from "node:assert/strict";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

const FIXTURE_ROW = {
	provider_name: "claude",
	model_id: "claude-sonnet-4-20250514",
	encrypted_api_key: "v1:aWl2:dGFn:Y2lwaGVydGV4dA==",
	api_key_last_four: "abcd",
};

async function insertRow(client, overrides = {}) {
	const row = { ...FIXTURE_ROW, ...overrides };
	return client.query(
		`INSERT INTO llm_provider_config (provider_name, model_id, encrypted_api_key, api_key_last_four, is_active)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[
			row.provider_name,
			row.model_id,
			row.encrypted_api_key,
			row.api_key_last_four,
			row.is_active ?? false,
		],
	);
}

test(
	"0002_llm_provider_config migration: table, CHECK constraints, and exactly-one-active partial unique index",
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
				`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'llm_provider_config'`,
			);
			assert.equal(
				tableRows.rows.length,
				1,
				"llm_provider_config must exist after migrate up (applied via the ordered 0001->0002 runner)",
			);

			// Unsupported provider_name is rejected by the CHECK constraint.
			await assert.rejects(
				() => insertRow(client, { provider_name: "openai" }),
				/violates check constraint/,
				"provider_name outside claude/deepseek/groq must violate the CHECK constraint",
			);

			// Blank model_id is rejected by the CHECK constraint.
			await assert.rejects(
				() => insertRow(client, { model_id: "   " }),
				/violates check constraint/,
				"blank model_id must violate the CHECK constraint",
			);

			// Exactly-one-active invariant: a second active row in the same
			// migration-level test must violate the partial unique index.
			await insertRow(client, { is_active: true });
			await assert.rejects(
				() => insertRow(client, { provider_name: "deepseek", is_active: true }),
				/duplicate key value violates unique constraint/,
				"a second active row must violate the partial unique index on is_active",
			);

			// A second INACTIVE row is fine — the invariant only restricts
			// concurrently active rows, not total row count.
			const inactiveInsert = await insertRow(client, {
				provider_name: "groq",
				is_active: false,
			});
			assert.equal(inactiveInsert.rows.length, 1);

			await migrate.migrateDown({ client });

			const tablesAfterDown = await client.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'llm_provider_config'`,
			);
			assert.equal(
				tablesAfterDown.rows.length,
				0,
				"llm_provider_config must be dropped after migrate down",
			);
		} finally {
			await client.end();
		}
	},
);
