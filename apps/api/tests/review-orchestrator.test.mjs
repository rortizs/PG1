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

/**
 * Exercises the REAL `review-run-lifecycle.mjs` + REAL `inline-review-queue.mjs`
 * + REAL `review-repository.mjs` against live Postgres, driven synchronously
 * from a single `lifecycle.startReviewRun()` call — matching the spec's
 * "Synchronous Review-Run Trigger" requirement. Only the worker's
 * extract/CAG HTTP calls are faked, per design.md's own testing strategy
 * ("Integration ... inline processor end-to-end | Dockerized pg; mocked
 * worker/Claude").
 */
async function setupPipeline({ client, runCagReview }) {
	const { createReviewRepository } = await import("../src/db/review-repository.mjs");
	const { createReviewPipeline } = await import("../src/jobs/review-orchestrator.mjs");

	const repository = createReviewRepository({ client });
	const normativeSourceIds = await repository.seedNormativeSources();

	const thesisDocumentDbId = await repository.insertThesisDocument({
		originalFilename: "thesis.pdf",
		contentType: "application/pdf",
		fileSizeBytes: 42,
		storageKey: `thesis-documents/orchestrator-test/${Math.random()}.pdf`,
		sha256: "c".repeat(64),
		uploadedByUserId: 1,
	});

	const { lifecycle } = createReviewPipeline({
		repository,
		resolveThesisDocumentDbId: async () => thesisDocumentDbId,
		extractThesisText: async () => ({ fullText: "Extracted thesis excerpt." }),
		runCagReview,
		resolveNormativeSourceId: async (ref) => normativeSourceIds[ref] ?? null,
	});

	return { repository, lifecycle, thesisDocumentDbId };
}

test(
	"review pipeline: grounded CAG result persists exactly one finding with evidence and reaches completed",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;

		const migrate = await import("../src/db/migrate.mjs");
		try {
			await migrate.migrateDown({ client }).catch(() => {});
			await migrate.migrateUp({ client });

			const { lifecycle } = await setupPipeline({
				client,
				runCagReview: async () => ({
					finding: {
						title: "Missing APA citation",
						explanation: "Excerpt paraphrases without citing.",
						recommendation: "Add an APA citation.",
						evidence_text: "Extracted thesis excerpt.",
						page_number: 2,
						section_title: null,
						normative_source_ref: "lineamientos_ingenieria_sistemas.txt",
						severity: "medium",
						confidence: 0.75,
						producer_id: "claude-sonnet-4",
					},
				}),
			});

			const response = await lifecycle.startReviewRun({
				documentId: "doc_grounded",
			});
			assert.equal(response.status, 202);

			const runAfter = lifecycle.getReviewRun(response.body.id);
			assert.equal(runAfter.body.status, "completed");
			assert.ok(runAfter.body.completed_at);

			const findingRows = await client.query(
				"SELECT count(*)::int AS count FROM finding",
			);
			assert.equal(findingRows.rows[0].count, 1);
			const evidenceRows = await client.query(
				"SELECT count(*)::int AS count FROM finding_evidence",
			);
			assert.equal(evidenceRows.rows[0].count, 1);

			await migrate.migrateDown({ client });
		} finally {
			await client.end();
		}
	},
);

test(
	"review pipeline: ungrounded CAG result yields zero findings and still completes",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;

		const migrate = await import("../src/db/migrate.mjs");
		try {
			await migrate.migrateDown({ client }).catch(() => {});
			await migrate.migrateUp({ client });

			const { lifecycle } = await setupPipeline({
				client,
				runCagReview: async () => ({ finding: null }),
			});

			const response = await lifecycle.startReviewRun({
				documentId: "doc_ungrounded",
			});

			const runAfter = lifecycle.getReviewRun(response.body.id);
			assert.equal(runAfter.body.status, "completed");

			const findingRows = await client.query(
				"SELECT count(*)::int AS count FROM finding",
			);
			assert.equal(findingRows.rows[0].count, 0);

			await migrate.migrateDown({ client });
		} finally {
			await client.end();
		}
	},
);

test(
	"review pipeline: a Claude API error transitions the run to failed with an error summary — never fabricates a finding",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;

		const migrate = await import("../src/db/migrate.mjs");
		try {
			await migrate.migrateDown({ client }).catch(() => {});
			await migrate.migrateUp({ client });

			const { lifecycle } = await setupPipeline({
				client,
				runCagReview: async () => {
					throw new Error("Claude API timeout");
				},
			});

			const response = await lifecycle.startReviewRun({
				documentId: "doc_failed",
			});

			const runAfter = lifecycle.getReviewRun(response.body.id);
			assert.equal(runAfter.body.status, "failed");
			assert.match(runAfter.body.error_summary, /Claude API timeout/);
			assert.ok(runAfter.body.failed_at);

			const findingRows = await client.query(
				"SELECT count(*)::int AS count FROM finding",
			);
			assert.equal(findingRows.rows[0].count, 0);

			await migrate.migrateDown({ client });
		} finally {
			await client.end();
		}
	},
);
