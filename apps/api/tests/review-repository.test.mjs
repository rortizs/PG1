import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("review-repository seeds normative sources and writes thesis_document -> review_run -> evidence_snippet -> finding -> finding_evidence", async (t) => {
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
		assert.equal(
			provenanceRow.rows[0].llm_model_id,
			"claude-sonnet-4-20250514",
		);

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
});

test("review-repository projects durable board cards and keeps reviewer workflow metadata separate from run status", async (t) => {
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
		const thesisDocumentId = await repository.insertThesisDocument({
			originalFilename: "lovelace-thesis.pdf",
			contentType: "application/pdf",
			fileSizeBytes: 2048,
			storageKey: "thesis-documents/board/lovelace-thesis.pdf",
			sha256: "c".repeat(64),
			uploadedByUserId: 1,
			metadata: {
				student_name: "Ada Lovelace",
				thesis_title: "Analytical Engines in Education",
			},
		});

		let cards = await repository.listReviewBoardCards();
		assert.equal(cards.length, 1);
		assert.equal(cards[0].student_name, "Ada Lovelace");
		assert.equal(cards[0].thesis_title, "Analytical Engines in Education");
		assert.equal(cards[0].priority, "normal");
		assert.equal(cards[0].board_state, "pending");
		assert.equal(cards[0].review_run_status, null);
		assert.equal(cards[0].report_ready, false);

		const reviewRunId = await repository.insertReviewRun({ thesisDocumentId });
		cards = await repository.listReviewBoardCards();
		assert.equal(cards[0].board_state, "in_review");
		assert.equal(cards[0].current_review_run_id, `review_run_${reviewRunId}`);

		await repository.updateReviewBoardPriority(cards[0].id, "urgent");
		cards = await repository.listReviewBoardCards();
		assert.equal(cards[0].priority, "urgent");
		const statusAfterPriority = await client.query(
			"SELECT status FROM review_run WHERE id = $1",
			[reviewRunId],
		);
		assert.equal(statusAfterPriority.rows[0].status, "queued");

		await repository.updateReviewRunStatus(reviewRunId, {
			status: "completed",
			completedAt: new Date(),
		});
		cards = await repository.listReviewBoardCards();
		assert.equal(cards[0].board_state, "reviewed");
		assert.equal(cards[0].report_ready, true);

		await repository.approveReviewBoardCard(cards[0].id, {
			reviewerName: "Dr. Rivera",
		});
		cards = await repository.listReviewBoardCards();
		assert.equal(cards[0].board_state, "approved");
		assert.equal(cards[0].reviewer_label, "Dr. Rivera");

		const failedDocumentId = await repository.insertThesisDocument({
			originalFilename: "failed.pdf",
			contentType: "application/pdf",
			fileSizeBytes: 1024,
			storageKey: "thesis-documents/board/failed.pdf",
			sha256: "d".repeat(64),
			uploadedByUserId: 1,
		});
		const failedRunId = await repository.insertReviewRun({
			thesisDocumentId: failedDocumentId,
		});
		await repository.updateReviewRunStatus(failedRunId, {
			status: "failed",
			failedAt: new Date(),
			errorSummary: "worker unavailable",
		});

		cards = await repository.listReviewBoardCards();
		const failedCard = cards.find(
			(card) => card.current_review_run_id === `review_run_${failedRunId}`,
		);
		assert.equal(failedCard.board_state, "in_review");
		assert.match(failedCard.attention_text, /failed/i);
		assert.match(failedCard.attention_text, /worker unavailable/);

		const cancelledDocumentId = await repository.insertThesisDocument({
			originalFilename: "cancelled.pdf",
			contentType: "application/pdf",
			fileSizeBytes: 1024,
			storageKey: "thesis-documents/board/cancelled.pdf",
			sha256: "e".repeat(64),
			uploadedByUserId: 1,
		});
		const cancelledRunId = await repository.insertReviewRun({
			thesisDocumentId: cancelledDocumentId,
		});
		await repository.updateReviewRunStatus(cancelledRunId, {
			status: "cancelled",
		});

		cards = await repository.listReviewBoardCards();
		const cancelledCard = cards.find(
			(card) => card.current_review_run_id === `review_run_${cancelledRunId}`,
		);
		assert.equal(cancelledCard.board_state, "in_review");
		assert.match(cancelledCard.attention_text, /cancelled/i);

		await migrate.migrateDown({ client });
	} finally {
		await client.end();
	}
});

test("insertDocumentPages/insertDocumentSections persist real page/section rows with resolved parent FK ids", async (t) => {
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

		const thesisDocumentId = await repository.insertThesisDocument({
			originalFilename: "thesis.pdf",
			contentType: "application/pdf",
			fileSizeBytes: 999,
			storageKey: "thesis-documents/sections/thesis.pdf",
			sha256: "e".repeat(64),
			uploadedByUserId: 1,
		});
		const reviewRunId = await repository.insertReviewRun({ thesisDocumentId });

		// N pages in -> N document_page rows with real page_number.
		const pagesResult = await repository.insertDocumentPages({
			reviewRunId,
			thesisDocumentId,
			pages: [
				{ pageNumber: 1, text: "Page one text." },
				{ pageNumber: 2, text: "Page two text." },
				{ pageNumber: 3, text: "Page three text." },
			],
			extractionMethod: "pdf_text",
		});
		assert.equal(pagesResult.ids.length, 3);
		for (const id of pagesResult.ids) assert.ok(Number.isInteger(id));
		assert.deepEqual(Object.keys(pagesResult.idByPageNumber).sort(), [
			"1",
			"2",
			"3",
		]);

		const pageRows = await client.query(
			"SELECT count(*)::int AS count FROM document_page WHERE review_run_id = $1",
			[reviewRunId],
		);
		assert.equal(pageRows.rows[0].count, 3);

		// M sections in document order -> M document_section rows, each
		// referencing the document_page it starts on via a resolved parent FK.
		const sectionsResult = await repository.insertDocumentSections({
			reviewRunId,
			sections: [
				{
					index: 0,
					parentIndex: null,
					sectionType: "chapter",
					title: "CAPÍTULO 1",
					normalizedTitle: "capitulo 1",
					startPageNumber: 1,
					endPageNumber: 3,
					startOffset: 0,
					endOffset: 10,
					isLocationUncertain: false,
					metadata: { detector: "heading_heuristic", confidence: 0.95 },
				},
				{
					index: 1,
					parentIndex: 0,
					sectionType: "section",
					title: "1.1 Subsection",
					normalizedTitle: "1.1 subsection",
					startPageNumber: 2,
					endPageNumber: 3,
					startOffset: 20,
					endOffset: 35,
					isLocationUncertain: false,
					metadata: {},
				},
			],
		});
		assert.equal(sectionsResult.ids.length, 2);
		assert.deepEqual(Object.keys(sectionsResult.idByIndex).sort(), ["0", "1"]);

		const sectionRows = await client.query(
			"SELECT id, parent_section_id, title FROM document_section WHERE review_run_id = $1 ORDER BY id",
			[reviewRunId],
		);
		assert.equal(sectionRows.rows.length, 2);
		assert.equal(sectionRows.rows[0].parent_section_id, null);
		assert.equal(
			Number(sectionRows.rows[1].parent_section_id),
			sectionsResult.idByIndex[0],
		);

		// TRIANGULATE: a parent-before-child ordering violation raises, not
		// silently orphans a section.
		await assert.rejects(() =>
			repository.insertDocumentSections({
				reviewRunId,
				sections: [
					{
						index: 0,
						parentIndex: 5, // never inserted — out-of-order reference
						sectionType: "section",
						title: "Orphan",
						normalizedTitle: "orphan",
						startPageNumber: 1,
						endPageNumber: 1,
						startOffset: 0,
						endOffset: 6,
						isLocationUncertain: false,
						metadata: {},
					},
				],
			}),
		);
		const orphanRows = await client.query(
			"SELECT count(*)::int AS count FROM document_section WHERE title = 'Orphan'",
		);
		assert.equal(orphanRows.rows[0].count, 0);

		await migrate.migrateDown({ client });
	} finally {
		await client.end();
	}
});

test("review-repository seeds normative segments, stores embeddings, and retrieves by vector similarity", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	const { createReviewRepository } = await import(
		"../src/db/review-repository.mjs"
	);
	const corpusDir = await mkdtemp(join(tmpdir(), "pg1-rag-corpus-"));
	const sourceTypeByFile = { "guide.txt": "gt_guide" };
	const embeddingProvider = {
		model: "deterministic-test-embedding-1536",
		embed: async (text) => {
			const vector = Array(1536).fill(0);
			if (/citation|apa/i.test(text)) vector[0] = 1;
			if (/margin|format/i.test(text)) vector[1] = 1;
			return vector;
		},
	};

	try {
		await writeFile(
			join(corpusDir, "guide.txt"),
			"APA citation rules require references.\n\nFormat pages with consistent margins.",
		);
		await migrate.migrateDown({ client }).catch(() => {});
		await migrate.migrateUp({ client });

		const repository = createReviewRepository({ client });
		const segmentIds = await repository.seedNormativeSegments({
			corpusDir,
			sourceTypeByFile,
		});
		assert.equal(segmentIds["guide.txt"].length, 2);

		const embeddingResult = await repository.seedNormativeEmbeddings({
			corpusDir,
			sourceTypeByFile,
			embeddingProvider,
		});
		assert.equal(embeddingResult.inserted + embeddingResult.existing, 2);

		const context = await repository.retrieveNormativeContext({
			queryText: "The thesis paraphrases prior work without an APA citation.",
			embeddingProvider,
			limit: 1,
		});
		assert.equal(context.length, 1);
		assert.match(context[0].segment_text, /APA citation/);
		assert.equal(context[0].source_ref, "guide.txt");
		assert.ok(Number.isFinite(context[0].similarity_score));

		const counts = await client.query(
			`SELECT
			   (SELECT count(*)::int FROM normative_segment) AS segment_count,
			   (SELECT count(*)::int FROM embedding_record) AS embedding_count`,
		);
		assert.deepEqual(counts.rows[0], { segment_count: 2, embedding_count: 2 });

		await migrate.migrateDown({ client });
	} finally {
		await rm(corpusDir, { recursive: true, force: true });
		await client.end();
	}
});

test("review-repository rejects a candidate finding with zero evidence rows — never persists it", async (t) => {
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
});
