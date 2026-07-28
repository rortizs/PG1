import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

/**
 * A minimal fake worker capturing exactly what `/internal/review` received,
 * so `defaultRunCagReview`'s request-body shape can be asserted directly —
 * no live Postgres needed for this one (pure HTTP-forwarding concern).
 */
function startFakeWorker() {
	let lastBody = null;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ finding: null }));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				url: `http://127.0.0.1:${port}`,
				getLastBody: () => lastBody,
				close: () => new Promise((res) => server.close(res)),
			});
		});
	});
}

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

test(
	"defaultRunCagReview forwards provider_name/api_key/model_id to the worker when supplied, and omits them entirely when not (backward compatible)",
	async () => {
		const worker = await startFakeWorker();
		const previousWorkerBaseUrl = process.env.WORKER_BASE_URL;
		// `DEFAULT_WORKER_BASE_URL` inside review-orchestrator.mjs is a
		// top-level const evaluated at import time — WORKER_BASE_URL MUST be
		// set before this dynamic import, or it locks in localhost:8000.
		process.env.WORKER_BASE_URL = worker.url;
		const { defaultRunCagReview } = await import(
			`../src/jobs/review-orchestrator.mjs?t=${Date.now()}`
		);
		try {
			await defaultRunCagReview({
				thesisText: "Some excerpt.",
				providerName: "claude",
				apiKey: "sk-ant-should-be-forwarded",
				modelId: "claude-sonnet-4-5-20250929",
			});
			assert.deepEqual(worker.getLastBody(), {
				thesis_text: "Some excerpt.",
				provider_name: "claude",
				api_key: "sk-ant-should-be-forwarded",
				model_id: "claude-sonnet-4-5-20250929",
			});

			await defaultRunCagReview({ thesisText: "Old-style call." });
			assert.deepEqual(worker.getLastBody(), { thesis_text: "Old-style call." });
		} finally {
			if (previousWorkerBaseUrl === undefined) delete process.env.WORKER_BASE_URL;
			else process.env.WORKER_BASE_URL = previousWorkerBaseUrl;
			await worker.close();
		}
	},
);
