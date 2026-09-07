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
	const row = { role: "judgment", ...FIXTURE_ROW, ...overrides };
	return client.query(
		`INSERT INTO llm_provider_config (provider_name, role, model_id, encrypted_api_key, api_key_last_four, is_active)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id`,
		[
			row.provider_name,
			row.role,
			row.model_id,
			row.encrypted_api_key,
			row.api_key_last_four,
			row.is_active ?? false,
		],
	);
}

test("llm provider role/provenance migrations: per-role active invariant, triage provenance columns, and loud ambiguous down", async (t) => {
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

		// Role validation lives in the schema too: unsupported roles are
		// rejected before any repository/admin contract code can mask it.
		await assert.rejects(
			() => insertRow(client, { role: "review" }),
			/violates check constraint/,
			"role outside judgment/triage must violate the role CHECK constraint",
		);

		// Exactly-one-active-per-role invariant: judgment and triage may both
		// be active, but a second active judgment must violate the new partial
		// unique index keyed by role.
		await insertRow(client, { role: "judgment", is_active: true });
		await insertRow(client, {
			provider_name: "deepseek",
			role: "triage",
			is_active: true,
		});
		await assert.rejects(
			() =>
				insertRow(client, {
					provider_name: "groq",
					role: "judgment",
					is_active: true,
				}),
			/duplicate key value violates unique constraint.*uq_llm_provider_config_one_active_per_role/s,
			"a second active row for the same role must violate the per-role partial unique index",
		);

		const activeByRole = await client.query(
			`SELECT role, count(*)::int AS count
				 FROM llm_provider_config
				 WHERE is_active
				 GROUP BY role
				 ORDER BY role`,
		);
		assert.deepEqual(activeByRole.rows, [
			{ role: "judgment", count: 1 },
			{ role: "triage", count: 1 },
		]);

		const triageColumns = await client.query(
			`SELECT column_name, is_nullable
				 FROM information_schema.columns
				 WHERE table_schema = 'public'
				   AND table_name = 'review_run'
				   AND column_name IN ('triage_provider_name', 'triage_model_id')
				 ORDER BY column_name`,
		);
		assert.deepEqual(triageColumns.rows, [
			{ column_name: "triage_model_id", is_nullable: "YES" },
			{ column_name: "triage_provider_name", is_nullable: "YES" },
		]);
		await assert.doesNotReject(() =>
			client.query(
				`INSERT INTO thesis_document (original_filename, content_type, file_size_bytes, storage_key, sha256, upload_status, uploaded_by_user_id)
					 VALUES ('nullable-triage.pdf', 'application/pdf', 1, 'test/nullable-triage.pdf', $1, 'uploaded', 1)`,
				["a".repeat(64)],
			),
		);
		await assert.doesNotReject(() =>
			client.query(
				`INSERT INTO review_run (thesis_document_id, status, pipeline_version, llm_provider_name, llm_model_id, triage_provider_name, triage_model_id)
					 VALUES ((SELECT id FROM thesis_document WHERE storage_key = 'test/nullable-triage.pdf'), 'completed', 'test', 'claude', 'claude-model', NULL, NULL)`,
			),
		);

		// DOWN must fail loudly while two roles are simultaneously active. That
		// ambiguity is recoverable by deactivating one role before rerunning down;
		// the migration must not silently choose which active provider survives.
		await assert.rejects(
			() => migrate.migrateDown({ client }),
			/duplicate key value violates unique constraint|could not create unique index/i,
			"migrate down must fail loudly when two active roles make the old global active invariant ambiguous",
		);

		await client.query(
			"UPDATE llm_provider_config SET is_active = false WHERE role = 'triage'",
		);
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
		await client
			.query(
				"UPDATE llm_provider_config SET is_active = false WHERE role = 'triage'",
			)
			.catch(() => {});
		if (migrate) await migrate.migrateDown({ client }).catch(() => {});
		await client.end();
	}
});
