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

	const { lifecycle, getReviewRunDbId } = createReviewPipeline({
		repository,
		resolveThesisDocumentDbId: async () => thesisDocumentDbId,
		extractThesisText: async () => ({ fullText: "Extracted thesis excerpt." }),
		runCagReview,
		resolveNormativeSourceId: async (ref) => normativeSourceIds[ref] ?? null,
	});

	return { repository, lifecycle, thesisDocumentDbId, getReviewRunDbId };
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

			const { lifecycle, repository, getReviewRunDbId } = await setupPipeline({
				client,
				// llm-provider-admin Work Unit 8: `runCagReview`'s result carries
				// the provider that actually produced this finding
				// (`live-review-pipeline.mjs`'s `runCagReviewWithActiveProvider`
				// augments its result with these two fields) — the orchestrator
				// must persist them onto the completed review_run.
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
					providerName: "claude",
					modelId: "claude-sonnet-4-20250514",
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

			const reviewRunDbId = getReviewRunDbId(response.body.id);
			const provenance = await repository.getReviewRunProvenance(reviewRunDbId);
			assert.deepEqual(provenance, {
				llmProviderName: "claude",
				llmModelId: "claude-sonnet-4-20250514",
			});

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
	"orchestrator inserts pages/sections before persisting any finding, and wires real documentPageId/documentSectionId (no live DB needed — a fake repository records call order and arguments)",
	async () => {
		const { createReviewOrchestrationProcessor } = await import(
			"../src/jobs/review-orchestrator.mjs"
		);

		const calls = [];
		const repository = {
			insertReviewRun: async () => 101,
			updateReviewRunStatus: async () => {},
			insertDocumentPages: async (args) => {
				calls.push({ fn: "insertDocumentPages", args });
				return { ids: [201, 202], idByPageNumber: { 1: 201, 2: 202 } };
			},
			insertDocumentSections: async (args) => {
				calls.push({ fn: "insertDocumentSections", args });
				return { ids: [301], idByIndex: { 0: 301 } };
			},
			persistFinding: async (args) => {
				calls.push({ fn: "persistFinding", args });
				return { findingId: 401, evidenceIds: [501] };
			},
		};
		const lifecycle = { transitionReviewRun: () => {}, markJobFailed: () => {} };

		const processor = createReviewOrchestrationProcessor({
			repository,
			lifecycle,
			resolveThesisDocumentDbId: async () => 1,
			extractThesisText: async () => ({
				fullText: "Full extracted text.",
				pages: [
					{ page_number: 1, section_title: null, text: "Page one." },
					{ page_number: 2, section_title: "CAPÍTULO 1", text: "Page two." },
				],
				sections: [
					{
						index: 0,
						parent_index: null,
						section_type: "chapter",
						title: "CAPÍTULO 1",
						normalized_title: "capitulo 1",
						start_page_number: 2,
						end_page_number: 2,
						start_offset: 0,
						end_offset: 10,
						is_location_uncertain: false,
						metadata: {},
					},
				],
				content_type: "application/pdf",
			}),
			runCagReview: async () => ({
				finding: {
					title: "Missing APA citation",
					explanation: "Paraphrases without citing.",
					recommendation: "Add a citation.",
					evidence_text: "Page two.",
					page_number: 2,
					section_title: "CAPÍTULO 1",
					normative_source_ref: "lineamientos_ingenieria_sistemas.txt",
					producer_id: "claude-fake",
				},
			}),
			resolveNormativeSourceId: async () => null,
		});

		await processor({
			review_run_id: "run_1",
			thesis_document_id: "doc_1",
		});

		const callOrder = calls.map((c) => c.fn);
		assert.deepEqual(callOrder, [
			"insertDocumentPages",
			"insertDocumentSections",
			"persistFinding",
		]);

		const pagesCall = calls[0].args;
		assert.equal(pagesCall.pages.length, 2);
		assert.equal(pagesCall.pages[0].pageNumber, 1);
		assert.equal(pagesCall.pages[1].pageNumber, 2);

		const sectionsCall = calls[1].args;
		assert.equal(sectionsCall.sections.length, 1);
		assert.equal(sectionsCall.sections[0].index, 0);
		assert.equal(sectionsCall.sections[0].sectionType, "chapter");

		const persistCall = calls[2].args;
		// Real FK ids resolved from insertDocumentPages/insertDocumentSections'
		// returned maps — never the pre-existing-behavior `null`.
		assert.equal(persistCall.evidence[0].documentPageId, 202);
		assert.equal(persistCall.evidence[0].documentSectionId, 301);
	},
);

test(
	"a review run with zero detected sections still persists pages and findings with documentSectionId null — never crashes",
	async () => {
		const { createReviewOrchestrationProcessor } = await import(
			"../src/jobs/review-orchestrator.mjs"
		);

		const calls = [];
		const repository = {
			insertReviewRun: async () => 102,
			updateReviewRunStatus: async () => {},
			insertDocumentPages: async (args) => {
				calls.push({ fn: "insertDocumentPages", args });
				return { ids: [211], idByPageNumber: { 1: 211 } };
			},
			insertDocumentSections: async (args) => {
				calls.push({ fn: "insertDocumentSections", args });
				return { ids: [], idByIndex: {} };
			},
			persistFinding: async (args) => {
				calls.push({ fn: "persistFinding", args });
				return { findingId: 402, evidenceIds: [502] };
			},
		};
		const lifecycle = { transitionReviewRun: () => {}, markJobFailed: () => {} };

		const processor = createReviewOrchestrationProcessor({
			repository,
			lifecycle,
			resolveThesisDocumentDbId: async () => 1,
			extractThesisText: async () => ({
				fullText: "Full extracted text.",
				pages: [{ page_number: 1, section_title: null, text: "Page one." }],
				sections: [],
				content_type: "application/pdf",
			}),
			runCagReview: async () => ({
				finding: {
					title: "Missing APA citation",
					explanation: "Paraphrases without citing.",
					recommendation: "Add a citation.",
					evidence_text: "Page one.",
					page_number: 1,
					section_title: null,
					normative_source_ref: "lineamientos_ingenieria_sistemas.txt",
					producer_id: "claude-fake",
				},
			}),
			resolveNormativeSourceId: async () => null,
		});

		await processor({
			review_run_id: "run_2",
			thesis_document_id: "doc_2",
		});

		const sectionsCall = calls.find((c) => c.fn === "insertDocumentSections").args;
		assert.deepEqual(sectionsCall.sections, []);

		const persistCall = calls.find((c) => c.fn === "persistFinding").args;
		assert.equal(persistCall.evidence[0].documentPageId, 211);
		assert.equal(persistCall.evidence[0].documentSectionId, null);
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
