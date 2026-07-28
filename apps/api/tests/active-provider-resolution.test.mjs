import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

const VALID_ENCRYPTION_KEY = "c".repeat(64); // 64 hex chars = 32 bytes

/**
 * A single fake worker for the whole file (started once, base URL locked
 * in exactly once via `WORKER_BASE_URL` before the first dynamic import —
 * `review-orchestrator.mjs`'s `DEFAULT_WORKER_BASE_URL` is a top-level
 * const evaluated at import time, so a fresh fake worker per scenario would
 * silently be ignored after the first import in this process). Records the
 * exact `/internal/review` body it last received, and its response is
 * swappable per scenario via `setNextReview`.
 */
function startFakeWorker() {
	let lastReviewBody = null;
	let nextReview = { status: 200, body: { finding: null } };
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			if (req.method === "POST" && req.url === "/internal/extract") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						filename: "thesis.pdf",
						content_type: "application/pdf",
						page_count: 1,
						pages: [{ page_number: 1, section_title: null, text: "excerpt" }],
						full_text: "Active-provider-resolution test thesis excerpt.",
					}),
				);
				return;
			}
			if (req.method === "POST" && req.url === "/internal/review") {
				lastReviewBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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
				getLastReviewBody: () => lastReviewBody,
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

async function triggerRun({ handleApiRequest, filename }) {
	const uploadRes = await handleApiRequest({
		method: "POST",
		path: "/api/v1/thesis-documents",
		body: { files: [pdfFile(filename)], uploaderUserId: 1 },
	});
	assert.equal(uploadRes.status, 201);
	return handleApiRequest({
		method: "POST",
		path: `/api/v1/thesis-documents/${uploadRes.body.id}/review-runs`,
		body: {},
	});
}

/**
 * Covers llm-provider-admin Work Unit 5 end to end against the REAL live
 * pipeline (dockerized Postgres + a fake HTTP worker): zero-active-provider
 * failure, per-run re-resolution across a provider switch (no restart), and
 * no raw-key leak into `error_summary` on a downstream worker failure.
 */
test(
	"active-provider resolution: zero-active fails explicitly, switching providers re-resolves per run, and a downstream failure never leaks the raw key",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;

		const migrate = await import("../src/db/migrate.mjs");
		await migrate.migrateDown({ client }).catch(() => {});
		await migrate.migrateUp({ client });
		await client.end();

		process.env.DATABASE_URL = databaseUrl;
		process.env.LLM_PROVIDER_ENCRYPTION_KEY = VALID_ENCRYPTION_KEY;
		delete process.env.ANTHROPIC_API_KEY;

		const worker = await startFakeWorker();
		process.env.WORKER_BASE_URL = worker.url;

		const { handleApiRequest } = await import("../src/api-contract.mjs");
		const { _resetLiveReviewPipelineForTests } = await import(
			"../src/live-review-pipeline.mjs"
		);
		const { createProviderConfigRepository } = await import(
			"../src/db/provider-config-repository.mjs"
		);
		_resetLiveReviewPipelineForTests();

		try {
			// --- Scenario 1: zero active providers -> explicit failure, worker never even called ---
			const runZeroActive = await triggerRun({ handleApiRequest, filename: "zero-active.pdf" });
			assert.equal(runZeroActive.status, 202);
			assert.equal(runZeroActive.body.status, "failed");
			assert.match(runZeroActive.body.error_summary, /no active LLM provider configured/i);
			assert.equal(
				worker.getLastReviewBody(),
				null,
				"resolution must fail before any /internal/review request is attempted",
			);

			// --- Scenario 2: activate provider one -> run completes, forwarding its exact fields ---
			const repository = createProviderConfigRepository({ connectionString: databaseUrl });
			const providerOne = await repository.create({
				providerName: "claude",
				modelId: "claude-model-one",
				apiKey: "sk-ant-provider-one-secret",
			});
			await repository.activate(providerOne.id);

			const runOne = await triggerRun({ handleApiRequest, filename: "provider-one.pdf" });
			assert.equal(runOne.body.status, "completed");
			assert.deepEqual(worker.getLastReviewBody(), {
				thesis_text: "Active-provider-resolution test thesis excerpt.",
				provider_name: "claude",
				api_key: "sk-ant-provider-one-secret",
				model_id: "claude-model-one",
			});

			// --- Scenario 3: switch active provider mid-session, no restart -> next run re-resolves fresh ---
			const providerTwo = await repository.create({
				providerName: "claude",
				modelId: "claude-model-two",
				apiKey: "sk-ant-provider-two-secret",
			});
			await repository.activate(providerTwo.id);

			const runTwo = await triggerRun({ handleApiRequest, filename: "provider-two.pdf" });
			assert.equal(runTwo.body.status, "completed");
			assert.deepEqual(worker.getLastReviewBody(), {
				thesis_text: "Active-provider-resolution test thesis excerpt.",
				provider_name: "claude",
				api_key: "sk-ant-provider-two-secret",
				model_id: "claude-model-two",
			});

			// --- Scenario 4: downstream worker failure while provider two is active -> failed, no key leak ---
			worker.setNextReview(502, {
				detail: "Claude API call failed: upstream timeout",
			});
			const runFailure = await triggerRun({ handleApiRequest, filename: "provider-two-failure.pdf" });
			assert.equal(runFailure.body.status, "failed");
			assert.ok(runFailure.body.error_summary);
			assert.doesNotMatch(
				runFailure.body.error_summary,
				/sk-ant-provider-two-secret/,
				"error_summary must never contain the active provider's raw api key",
			);
		} finally {
			await worker.close();
			const { default: pg } = await import("pg");
			const cleanupClient = new pg.Client({ connectionString: databaseUrl });
			await cleanupClient.connect();
			await migrate.migrateDown({ client: cleanupClient }).catch(() => {});
			await cleanupClient.end();
		}
	},
);
