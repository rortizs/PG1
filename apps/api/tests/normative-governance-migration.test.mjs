import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * thesis-normative-governance PR1 "governance spine", Work Unit 1
 * (design.md D1/D2): `0006_normative_governance.sql` adds a
 * schema-generated `precedence` column, retypes the existing Reglamento
 * corpus row, seeds a metadata-only `apa_6` row, and widens
 * `finding.finding_type` with `'structure'`.
 *
 * `seedNormativeSources()` is called BEFORE 0006 is applied in every test
 * below (via per-file `migrationPath` application through 0001-0005, then
 * 0006 on its own) to reproduce design.md D1's grounding fact: the
 * Reglamento corpus row already exists, mis-typed `'rubric'`, on a
 * pre-existing production DB — the exact scenario the migration's UPDATE
 * targets.
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

/**
 * Applies every migration EXCEPT 0006 (the pre-existing baseline schema),
 * seeds the corpus with an EXPLICIT legacy source-type map — i.e.
 * `lineamientos_ingenieria_sistemas.txt` still typed `'rubric'` —
 * reproducing an existing production DB the instant before 0006 is
 * applied. Deliberately NOT the repository's live `DEFAULT_SOURCE_TYPE_BY_FILE`
 * default, so this test stays correct even after Work Unit 4 corrects that
 * map to `reglamento_tesis` directly.
 */
async function migrateUpToBaselineAndSeedLegacyCorpus(migrate, client) {
	const { createReviewRepository } = await import(
		"../src/db/review-repository.mjs"
	);

	const allFiles = await migrate.listMigrationFiles();
	const baselineFiles = allFiles.filter(
		(url) => !url.pathname.endsWith("0006_normative_governance.sql"),
	);
	for (const migrationPath of baselineFiles) {
		await migrate.migrateUp({ client, migrationPath });
	}

	const repository = createReviewRepository({ client });
	const legacySourceTypeByFile = {
		"tesis_guia_trabajo_gt.txt": "gt_guide",
		"plantilla_sugerida_trabajo_graduacion.txt": "gt_guide",
		"lineamientos_ingenieria_sistemas.txt": "rubric",
		"ejemplo_para_guia.txt": "example_observation",
	};
	return repository.seedNormativeSources({
		sourceTypeByFile: legacySourceTypeByFile,
	});
}

async function apply0006(migrate, client) {
	const allFiles = await migrate.listMigrationFiles();
	const migrationPath = allFiles.find((url) =>
		url.pathname.endsWith("0006_normative_governance.sql"),
	);
	await migrate.migrateUp({ client, migrationPath });
	return migrationPath;
}

test("0006_normative_governance migration: retypes the existing Reglamento row and resolves precedence tiers 1/2/3", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrateUpToBaselineAndSeedLegacyCorpus(migrate, client);
		await apply0006(migrate, client);

		const reglamentoRow = await client.query(
			`SELECT source_type, precedence FROM normative_source WHERE title = 'lineamientos_ingenieria_sistemas.txt'`,
		);
		assert.equal(reglamentoRow.rows.length, 1);
		assert.equal(reglamentoRow.rows[0].source_type, "reglamento_tesis");
		assert.equal(reglamentoRow.rows[0].precedence, 1);

		const apa6Row = await client.query(
			`SELECT precedence, is_approved FROM normative_source WHERE source_type = 'apa_6'`,
		);
		assert.equal(apa6Row.rows.length, 1);
		assert.equal(apa6Row.rows[0].precedence, 2);
		assert.equal(apa6Row.rows[0].is_approved, true);

		const gtGuideRows = await client.query(
			`SELECT DISTINCT precedence FROM normative_source WHERE source_type = 'gt_guide'`,
		);
		assert.equal(gtGuideRows.rows.length, 1);
		assert.equal(gtGuideRows.rows[0].precedence, 3);

		const indexRow = await client.query(
			`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_normative_source_precedence'`,
		);
		assert.equal(indexRow.rows.length, 1);
	} finally {
		await client
			.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
			.catch(() => {});
		await client.end();
	}
});

test("0006_normative_governance migration: 'structure' finding_type is accepted after the migration", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrateUpToBaselineAndSeedLegacyCorpus(migrate, client);
		await apply0006(migrate, client);

		const docRow = await client.query(
			`INSERT INTO thesis_document
			   (original_filename, content_type, file_size_bytes, storage_key, sha256, upload_status, uploaded_by_user_id)
			 VALUES ('t.pdf', 'application/pdf', 10, 'k', $1, 'uploaded', 1)
			 RETURNING id`,
			["b".repeat(64)],
		);
		const reviewRunRow = await client.query(
			`INSERT INTO review_run (thesis_document_id, status, pipeline_version)
			 VALUES ($1, 'queued', 'pipeline-v1') RETURNING id`,
			[docRow.rows[0].id],
		);
		const findingRow = await client.query(
			`INSERT INTO finding
			   (review_run_id, finding_type, severity, confidence, title, explanation, producer_type, producer_id, status)
			 VALUES ($1, 'structure', 'medium', 0.9, 'Falta página preliminar', 'Explicación.', 'deterministic_rule', 'rules@v1', 'valid')
			 RETURNING id`,
			[reviewRunRow.rows[0].id],
		);
		// pg returns BIGINT columns as strings — assert presence/shape, not
		// `Number.isInteger` (mirrors review-repository.mjs's own `toId()`
		// rationale for why every id needs an explicit numeric coercion).
		assert.ok(findingRow.rows[0].id);
		assert.ok(Number.isInteger(Number(findingRow.rows[0].id)));
	} finally {
		await client
			.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
			.catch(() => {});
		await client.end();
	}
});

test("0006_normative_governance migration: seeding apa_6 twice stays idempotent, and precedence is not directly insertable", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrateUpToBaselineAndSeedLegacyCorpus(migrate, client);
		await apply0006(migrate, client);

		// Re-running the exact guarded INSERT the migration itself uses must
		// never create a second apa_6 row.
		await client.query(
			`INSERT INTO normative_source (source_type, title, version_label, is_approved, metadata)
			 SELECT 'apa_6', 'Manual de Normas APA (6a edición)', '6a edición', true,
			        '{"seeded_by":"0006_normative_governance","corpus_file":null}'
			 WHERE NOT EXISTS (SELECT 1 FROM normative_source WHERE source_type = 'apa_6')`,
		);
		const apa6Rows = await client.query(
			`SELECT count(*)::int AS count FROM normative_source WHERE source_type = 'apa_6'`,
		);
		assert.equal(apa6Rows.rows[0].count, 1);

		// The generated `precedence` column structurally rejects an explicit
		// insert value — satisfies the spec's "insert without precedence is
		// rejected" scenario without any application-level check.
		await assert.rejects(
			client.query(
				`INSERT INTO normative_source (source_type, title, is_approved, precedence)
				 VALUES ('gt_guide', 'explicit-precedence-test.txt', true, 3)`,
			),
			/precedence/i,
		);
	} finally {
		await client
			.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
			.catch(() => {});
		await client.end();
	}
});

test("0006_normative_governance migration DOWN: retypes Reglamento back to rubric, deletes the seeded apa_6 row, and narrows CHECKs cleanly", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrateUpToBaselineAndSeedLegacyCorpus(migrate, client);
		const migrationPath = await apply0006(migrate, client);

		await migrate.migrateDown({ client, migrationPath });

		const reglamentoRow = await client.query(
			`SELECT source_type FROM normative_source WHERE title = 'lineamientos_ingenieria_sistemas.txt'`,
		);
		assert.equal(reglamentoRow.rows.length, 1);
		assert.equal(reglamentoRow.rows[0].source_type, "rubric");

		const apa6Rows = await client.query(
			`SELECT count(*)::int AS count FROM normative_source WHERE source_type = 'apa_6'`,
		);
		assert.equal(apa6Rows.rows[0].count, 0);

		const columnRow = await client.query(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'normative_source' AND column_name = 'precedence'`,
		);
		assert.equal(columnRow.rows.length, 0);

		// The narrower (pre-0006) CHECK is restored and rejects 'reglamento_tesis'.
		await assert.rejects(
			client.query(
				`INSERT INTO normative_source (source_type, title, is_approved) VALUES ('reglamento_tesis', 'should-fail.txt', true)`,
			),
			/normative_source_source_type_check/i,
		);
	} finally {
		await client
			.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
			.catch(() => {});
		await client.end();
	}
});
