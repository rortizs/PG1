import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAuthenticatedSession } from "./support/reviewer-session-fixture.mjs";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;
const VALID_ENCRYPTION_KEY = "e".repeat(64);

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

async function resetSchemaToHead(client) {
	const migrate = await import("../src/db/migrate.mjs");
	await migrate.migrateDown({ client }).catch(() => {});
	await migrate.migrateUp({ client });
}

function startFakeWorker() {
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			if (req.method === "POST" && req.url === "/internal/extract") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						filename: "cold-registry.pdf",
						content_type: "application/pdf",
						page_count: 1,
						pages: [
							{
								page_number: 1,
								section_title: "Chapter",
								text: "Cold registry document text.",
							},
						],
						full_text: "Cold registry document text.",
						sections: [
							{
								index: 0,
								parent_index: null,
								section_type: "chapter",
								title: "Chapter",
								normalized_title: "chapter",
								start_page_number: 1,
								end_page_number: 1,
								start_offset: 0,
								end_offset: 10,
								is_location_uncertain: false,
								metadata: {},
							},
						],
					}),
				);
				return;
			}
			if (req.method === "POST" && req.url === "/internal/review") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ findings: [], stats: { chunks: 1 } }));
				return;
			}
			if (req.method === "POST" && req.url === "/internal/rules") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ findings: [] }));
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
				close: () => new Promise((res) => server.close(res)),
			});
		});
	});
}

function pdfFile(name) {
	const content = Buffer.from(`%PDF-1.4 fake bytes for ${name}`);
	return {
		filename: name,
		contentType: "application/pdf",
		content,
		size: content.byteLength,
	};
}

test("review-run creation uses durable thesis documents when the uploaded-document registry is cold", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;
	const worker = await startFakeWorker();
	try {
		await resetSchemaToHead(client);
		process.env.DATABASE_URL = databaseUrl;
		process.env.LLM_PROVIDER_ENCRYPTION_KEY = VALID_ENCRYPTION_KEY;
		process.env.WORKER_BASE_URL = worker.url;

		const { handleApiRequest } = await import("../src/api-contract.mjs");
		const { _resetLiveReviewPipelineForTests } = await import(
			"../src/live-review-pipeline.mjs"
		);
		const { createProviderConfigRepository } = await import(
			"../src/db/provider-config-repository.mjs"
		);
		_resetLiveReviewPipelineForTests();

		const providerRepository = createProviderConfigRepository({
			connectionString: databaseUrl,
		});
		const provider = await providerRepository.create({
			providerName: "claude",
			modelId: "claude-sonnet-4-20250514",
			apiKey: "sk-ant-cold-registry-fixture-key",
		});
		await providerRepository.activate(provider.id);

		const session = await createAuthenticatedSession({
			connectionString: databaseUrl,
		});
		const upload = await handleApiRequest({
			method: "POST",
			path: "/api/v1/thesis-documents",
			headers: session.headers,
			body: { files: [pdfFile("cold-registry.pdf")] },
		});
		assert.equal(upload.status, 201);
		const documentId = upload.body.id;

		_resetLiveReviewPipelineForTests();

		const run = await handleApiRequest({
			method: "POST",
			path: `/api/v1/thesis-documents/${documentId}/review-runs`,
			headers: session.headers,
			body: { pipelineVersion: "pipeline-cold-registry" },
		});

		assert.equal(run.status, 202);
		assert.equal(run.body.thesis_document_id, documentId);
		assert.equal(run.body.status, "completed");
		assert.ok(run.body.completed_at);
	} finally {
		await worker.close();
		await client.end();
	}
});
