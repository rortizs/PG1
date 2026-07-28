import { test } from "node:test";
import assert from "node:assert/strict";

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

test(
	"review-repository seeds normative sources and writes thesis_document -> review_run -> evidence_snippet -> finding -> finding_evidence",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;

		const migrate = await import("../src/db/migrate.mjs");
		const { createReviewRepository } = await import(
			"../src/db/review-repository.mjs"
		);

		try {
			await migrate.migrateDown({ client }).catch(() => {});
			await migrate.migrateUp({ client });

			const repository = createReviewRepository({ client });

			const sourceIdsByFile = await repository.seedNormativeSources();
			const seededFiles = Object.keys(sourceIdsByFile);
			assert.equal(seededFiles.length, 4);
			for (const file of seededFiles) {
				assert.ok(Number.isInteger(sourceIdsByFile[file]));
			}

			// Seeding must be idempotent: seeding again returns the same IDs
			// instead of inserting duplicate normative_source rows.
			const sourceIdsAgain = await repository.seedNormativeSources();
			assert.deepEqual(sourceIdsAgain, sourceIdsByFile);
			const countRows = await client.query(
				"SELECT count(*)::int AS count FROM normative_source",
			);
			assert.equal(countRows.rows[0].count, 4);

			const thesisDocumentId = await repository.insertThesisDocument({
				originalFilename: "thesis.pdf",
				contentType: "application/pdf",
				fileSizeBytes: 1234,
				storageKey: "thesis-documents/abc/thesis.pdf",
				sha256: "a".repeat(64),
				uploadedByUserId: 1,
			});
			assert.ok(Number.isInteger(thesisDocumentId));

			const reviewRunId = await repository.insertReviewRun({
				thesisDocumentId,
				pipelineVersion: "pipeline-v1",
			});
			assert.ok(Number.isInteger(reviewRunId));

			await repository.updateReviewRunStatus(reviewRunId, {
				status: "rag_reviewing",
				startedAt: new Date(),
			});
			const midRun = await client.query(
				"SELECT status, started_at FROM review_run WHERE id = $1",
				[reviewRunId],
			);
			assert.equal(midRun.rows[0].status, "rag_reviewing");
			assert.ok(midRun.rows[0].started_at);

			const normativeSourceId =
				sourceIdsByFile["lineamientos_ingenieria_sistemas.txt"];
			const { findingId, evidenceIds } = await repository.persistFinding({
				reviewRunId,
				normativeSourceId,
				finding: {
					title: "Missing APA citation",
					explanation: "The excerpt paraphrases a source without citing it.",
					recommendation: "Add an APA-style in-text citation.",
					producerId: "claude-sonnet-4",
				},
				evidence: [
					{
						evidenceText: "Studies show thesis quality improves with review.",
						pageNumber: 3,
					},
				],
			});
			assert.ok(Number.isInteger(findingId));
			assert.equal(evidenceIds.length, 1);

			const findingRow = await client.query(
				"SELECT review_run_id, finding_type, producer_type, normative_source_id, status FROM finding WHERE id = $1",
				[findingId],
			);
			// `pg` returns BIGINT columns as strings — coerce before comparing.
			assert.equal(Number(findingRow.rows[0].review_run_id), reviewRunId);
			assert.equal(findingRow.rows[0].finding_type, "rag_review");
			assert.equal(findingRow.rows[0].producer_type, "controlled_rag");
			assert.equal(
				Number(findingRow.rows[0].normative_source_id),
				normativeSourceId,
			);
			assert.equal(findingRow.rows[0].status, "valid");

			const joinRows = await client.query(
				"SELECT finding_id, evidence_snippet_id FROM finding_evidence WHERE finding_id = $1",
				[findingId],
			);
			assert.equal(joinRows.rows.length, 1);
			assert.equal(Number(joinRows.rows[0].evidence_snippet_id), evidenceIds[0]);

			const findings = await repository.listFindingsForReviewRun(reviewRunId);
			assert.equal(findings.length, 1);
			assert.equal(findings[0].title, "Missing APA citation");
			assert.equal(
				findings[0].evidence_text,
				"Studies show thesis quality improves with review.",
			);
			assert.equal(findings[0].page_number, 3);
			assert.match(findings[0].id, /^finding_/);

			// llm-provider-admin Work Unit 8: provider provenance on a completed
			// review_run. Written by the orchestrator alongside the completion
			// status update — verify both the write and the dedicated read path.
			await repository.updateReviewRunStatus(reviewRunId, {
				completedAt: new Date(),
				llmProviderName: "claude",
				llmModelId: "claude-sonnet-4-20250514",
			});
			const provenanceRow = await client.query(
				"SELECT llm_provider_name, llm_model_id FROM review_run WHERE id = $1",
				[reviewRunId],
			);
			assert.equal(provenanceRow.rows[0].llm_provider_name, "claude");
			assert.equal(provenanceRow.rows[0].llm_model_id, "claude-sonnet-4-20250514");

			const provenance = await repository.getReviewRunProvenance(reviewRunId);
			assert.deepEqual(provenance, {
				llmProviderName: "claude",
				llmModelId: "claude-sonnet-4-20250514",
			});

			// A run whose provenance was never set (e.g. pre-existing runs from
			// before this change) must read back gracefully as nulls, never throw.
			const otherRunId = await repository.insertReviewRun({ thesisDocumentId });
			const noProvenance = await repository.getReviewRunProvenance(otherRunId);
			assert.deepEqual(noProvenance, { llmProviderName: null, llmModelId: null });

			await migrate.migrateDown({ client });
			const tablesAfterDown = await client.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
			);
			assert.equal(tablesAfterDown.rows.length, 0);
		} finally {
			await client.end();
		}
	},
);

test(
	"review-repository rejects a candidate finding with zero evidence rows — never persists it",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;

		const migrate = await import("../src/db/migrate.mjs");
		const { createReviewRepository, EvidenceRequiredError } = await import(
			"../src/db/review-repository.mjs"
		);

		try {
			await migrate.migrateDown({ client }).catch(() => {});
			await migrate.migrateUp({ client });

			const repository = createReviewRepository({ client });
			const thesisDocumentId = await repository.insertThesisDocument({
				originalFilename: "thesis.pdf",
				contentType: "application/pdf",
				fileSizeBytes: 10,
				storageKey: "thesis-documents/zero-evidence/thesis.pdf",
				sha256: "b".repeat(64),
				uploadedByUserId: 1,
			});
			const reviewRunId = await repository.insertReviewRun({
				thesisDocumentId,
			});

			await assert.rejects(
				() =>
					repository.persistFinding({
						reviewRunId,
						normativeSourceId: null,
						finding: {
							title: "Unevidenced claim",
							explanation: "No locatable text in the thesis.",
							recommendation: "N/A",
							producerId: "claude-sonnet-4",
						},
						evidence: [],
					}),
				EvidenceRequiredError,
			);

			const findingCount = await client.query(
				"SELECT count(*)::int AS count FROM finding WHERE review_run_id = $1",
				[reviewRunId],
			);
			assert.equal(findingCount.rows[0].count, 0);

			await migrate.migrateDown({ client });
		} finally {
			await client.end();
		}
	},
);
