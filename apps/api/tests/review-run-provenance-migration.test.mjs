import { test } from "node:test";
import assert from "node:assert/strict";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

/**
 * llm-provider-admin Work Unit 8: `review_run` provenance columns.
 * `design.md`'s File Changes table scopes `0002` to the registry table only
 * (no explicit run-provenance column names) — `tasks.md`'s own Scope Guard
 * flags this as an inferred addition, confirmed as a follow-on `0003`
 * migration. This test is the schema-level proof of that decision:
 * `llm_provider_name`/`llm_model_id` are nullable (existing/pre-change runs
 * must render gracefully, never error) and, when present, restricted to the
 * same supported-provider set as `llm_provider_config.provider_name`.
 */
async function insertThesisDocumentAndReviewRun(client) {
	const docResult = await client.query(
		`INSERT INTO thesis_document
		   (original_filename, content_type, file_size_bytes, storage_key, sha256, upload_status, uploaded_by_user_id)
		 VALUES ('t.pdf', 'application/pdf', 10, 'k', $1, 'uploaded', 1)
		 RETURNING id`,
		["a".repeat(64)],
	);
	const thesisDocumentId = docResult.rows[0].id;
	const runResult = await client.query(
		`INSERT INTO review_run (thesis_document_id, status, pipeline_version)
		 VALUES ($1, 'queued', 'pipeline-v1') RETURNING id`,
		[thesisDocumentId],
	);
	return runResult.rows[0].id;
}

test(
	"0003_review_run_provider_provenance migration: nullable llm_provider_name/llm_model_id columns on review_run",
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
			await migrate.migrateDown({ client }).catch(() => {});
			await migrate.migrateUp({ client });

			const columnRows = await client.query(
				`SELECT column_name, is_nullable FROM information_schema.columns
				 WHERE table_schema = 'public' AND table_name = 'review_run'
				   AND column_name IN ('llm_provider_name', 'llm_model_id')
				 ORDER BY column_name`,
			);
			assert.equal(
				columnRows.rows.length,
				2,
				"both llm_provider_name and llm_model_id must exist on review_run after migrate up",
			);
			for (const row of columnRows.rows) {
				assert.equal(
					row.is_nullable,
					"YES",
					`${row.column_name} must be nullable — pre-existing runs have no provenance`,
				);
			}

			// A review_run with NO provenance set (the pre-existing-run case) must
			// be a perfectly valid row — never an error, never a fabricated value.
			const reviewRunId = await insertThesisDocumentAndReviewRun(client);
			const nullRow = await client.query(
				"SELECT llm_provider_name, llm_model_id FROM review_run WHERE id = $1",
				[reviewRunId],
			);
			assert.equal(nullRow.rows[0].llm_provider_name, null);
			assert.equal(nullRow.rows[0].llm_model_id, null);

			// Setting a supported provider name succeeds.
			await client.query(
				"UPDATE review_run SET llm_provider_name = 'claude', llm_model_id = 'claude-sonnet-4-20250514' WHERE id = $1",
				[reviewRunId],
			);
			const populatedRow = await client.query(
				"SELECT llm_provider_name, llm_model_id FROM review_run WHERE id = $1",
				[reviewRunId],
			);
			assert.equal(populatedRow.rows[0].llm_provider_name, "claude");
			assert.equal(populatedRow.rows[0].llm_model_id, "claude-sonnet-4-20250514");

			// An unsupported provider name is rejected by the CHECK constraint —
			// consistent with llm_provider_config.provider_name's own enum.
			await assert.rejects(
				() =>
					client.query(
						"UPDATE review_run SET llm_provider_name = 'openai' WHERE id = $1",
						[reviewRunId],
					),
				/violates check constraint/,
			);

			await migrate.migrateDown({ client });
			const columnsAfterDown = await client.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
			);
			assert.equal(
				columnsAfterDown.rows.length,
				0,
				"migrate down must clean up the whole schema (review_run included)",
			);
		} finally {
			await client.end();
		}
	},
);
