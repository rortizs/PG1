import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

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
 * A minimal fake worker: real HTTP, no multipart parsing (the fake never
 * needs the actual file bytes), responding to `/internal/extract` and
 * `/internal/review` exactly like the real FastAPI worker's response
 * shapes (see services/worker/app/main.py). Lets this test prove the real
 * `fetch()` calls in `live-review-pipeline.mjs`/`review-orchestrator.mjs`
 * work end to end without needing Python or a live `ANTHROPIC_API_KEY`.
 */
function startFakeWorker() {
	let nextReview = { status: 200, body: { finding: null } };
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			if (req.method === "POST" && req.url === "/internal/extract") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						filename: "thesis.pdf",
						content_type: "application/pdf",
						page_count: 1,
						pages: [{ page_number: 1, section_title: null, text: "excerpt" }],
						full_text: "Live wiring integration test thesis excerpt.",
					}),
				);
				return;
			}
			if (req.method === "POST" && req.url === "/internal/review") {
				res.writeHead(nextReview.status, { "content-type": "application/json" });
				res.end(JSON.stringify(nextReview.body));
				return;
			}
			res.writeHead(404);
			res.end();
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				url: `http://127.0.0.1:${port}`,
				setNextReview(status, body) {
					nextReview = { status, body };
				},
				close: () => new Promise((res) => server.close(res)),
			});
		});
	});
}

function pdfFile(name) {
	return {
		filename: name,
		contentType: "application/pdf",
		content: Buffer.from(`%PDF-1.4 fake bytes for ${name}`),
		size: Buffer.from(`%PDF-1.4 fake bytes for ${name}`).byteLength,
	};
}

test(
	"live HTTP review-run route drives the real pipeline end to end for genuinely uploaded documents, and leaves fabricated ids on the stub path",
	async (t) => {
		const probeClient = await connectOrSkip(t);
		if (!probeClient) return;

		const migrate = await import("../src/db/migrate.mjs");
		await migrate.migrateDown({ client: probeClient }).catch(() => {});
		await migrate.migrateUp({ client: probeClient });
		await probeClient.end();

		process.env.DATABASE_URL = databaseUrl;
		const worker = await startFakeWorker();
		process.env.WORKER_BASE_URL = worker.url;

		const { handleApiRequest } = await import("../src/api-contract.mjs");
		const { _resetLiveReviewPipelineForTests } = await import(
			"../src/live-review-pipeline.mjs"
		);
		_resetLiveReviewPipelineForTests();

		try {
			// --- Scenario 1: grounded finding -> completed, exactly one persisted finding ---
			worker.setNextReview(200, {
				finding: {
					finding_type: "rag_review",
					severity: "medium",
					confidence: 0.8,
					title: "Missing APA citation",
					explanation: "The excerpt paraphrases a source without citing it.",
					recommendation: "Add an APA in-text citation.",
					evidence_text: "Live wiring integration test thesis excerpt.",
					page_number: 1,
					section_title: null,
					normative_source_ref: "lineamientos_ingenieria_sistemas.txt",
					producer_type: "controlled_rag",
					producer_id: "claude-fake",
				},
			});

			const uploadRes = await handleApiRequest({
				method: "POST",
				path: "/api/v1/thesis-documents",
				body: { files: [pdfFile("grounded.pdf")], uploaderUserId: 1 },
			});
			assert.equal(uploadRes.status, 201);
			assert.equal(uploadRes.body.review_eligible, true);
			const documentId = uploadRes.body.id;

			const runRes = await handleApiRequest({
				method: "POST",
				path: `/api/v1/thesis-documents/${documentId}/review-runs`,
				body: {},
			});
			// Real, previously-uploaded documents complete SYNCHRONOUSLY within
			// this same request/response — never the fabricated "queued" stub.
			assert.equal(runRes.status, 202);
			assert.equal(runRes.body.status, "completed");
			assert.ok(runRes.body.completed_at);
			const runId = runRes.body.id;

			const statusRes = await handleApiRequest({
				method: "GET",
				path: `/api/v1/review-runs/${runId}`,
			});
			assert.equal(statusRes.status, 200);
			assert.equal(statusRes.body.status, "completed");
			assert.equal(statusRes.body.summary.findings, 1);

			const findingsRes = await handleApiRequest({
				method: "GET",
				path: `/api/v1/review-runs/${runId}/findings`,
			});
			assert.equal(findingsRes.status, 200);
			assert.equal(findingsRes.body.items.length, 1);
			assert.equal(findingsRes.body.items[0].title, "Missing APA citation");
			assert.equal(
				findingsRes.body.items[0].evidence_text,
				"Live wiring integration test thesis excerpt.",
			);

			// --- Scenario 2: ungrounded -> completed, zero findings (never fabricated) ---
			worker.setNextReview(200, { finding: null });

			const uploadRes2 = await handleApiRequest({
				method: "POST",
				path: "/api/v1/thesis-documents",
				body: { files: [pdfFile("ungrounded.pdf")], uploaderUserId: 1 },
			});
			const runRes2 = await handleApiRequest({
				method: "POST",
				path: `/api/v1/thesis-documents/${uploadRes2.body.id}/review-runs`,
				body: {},
			});
			assert.equal(runRes2.body.status, "completed");

			const findingsRes2 = await handleApiRequest({
				method: "GET",
				path: `/api/v1/review-runs/${runRes2.body.id}/findings`,
			});
			assert.equal(findingsRes2.body.items.length, 0);

			// --- Scenario 3: worker/Claude failure -> failed, real error_summary, never fabricated ---
			worker.setNextReview(500, {
				detail: "configuration_error: ANTHROPIC_API_KEY is not set",
			});

			const uploadRes3 = await handleApiRequest({
				method: "POST",
				path: "/api/v1/thesis-documents",
				body: { files: [pdfFile("failure.pdf")], uploaderUserId: 1 },
			});
			const runRes3 = await handleApiRequest({
				method: "POST",
				path: `/api/v1/thesis-documents/${uploadRes3.body.id}/review-runs`,
				body: {},
			});
			assert.equal(runRes3.body.status, "failed");
			assert.match(runRes3.body.error_summary, /configuration_error/);

			const findingsRes3 = await handleApiRequest({
				method: "GET",
				path: `/api/v1/review-runs/${runRes3.body.id}/findings`,
			});
			assert.equal(findingsRes3.body.items.length, 0);

			// --- Control: a fabricated, never-uploaded document id still gets the
			// existing immediate "queued" stub response, exactly like
			// contract.test.mjs's protected assertion — proving the real-pipeline
			// wiring above did not change behavior for unknown documents. ---
			const stubRunRes = await handleApiRequest({
				method: "POST",
				path: "/api/v1/thesis-documents/doc_never_uploaded/review-runs",
				body: { pipelineVersion: "pipeline-live-test" },
			});
			assert.equal(stubRunRes.status, 202);
			assert.equal(stubRunRes.body.status, "queued");
			assert.equal(stubRunRes.body.progress_stage, "queued");
		} finally {
			await worker.close();
			const { default: pg } = await import("pg");
			const cleanupClient = new pg.Client({ connectionString: databaseUrl });
			await cleanupClient.connect();
			await migrate.migrateDown({ client: cleanupClient });
			await cleanupClient.end();
		}
	},
);
