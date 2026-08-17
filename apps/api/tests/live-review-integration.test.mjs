import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

// llm-provider-admin (Work Unit 5): every review-run trigger now resolves
// the DB-active provider first — a necessary, deliberate update to this
// pre-existing test (see apply-progress.md's "A necessary, deliberate
// change" note). Without seeding an active row, scenarios 1-2 below would
// now genuinely fail at the "no active LLM provider configured" step before
// ever reaching this file's fake worker, which is not what those scenarios
// are testing.
const VALID_ENCRYPTION_KEY = "d".repeat(64); // 64 hex chars = 32 bytes

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
	// precise-thesis-review-pipeline Work Unit 5: the deterministic rule
	// engine's own independent route — defaults to "zero findings" so every
	// pre-existing scenario below (which never sets this) behaves exactly as
	// before this pass.
	let nextRules = { status: 200, body: { findings: [] } };
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			if (req.method === "POST" && req.url === "/internal/rules") {
				res.writeHead(nextRules.status, { "content-type": "application/json" });
				res.end(JSON.stringify(nextRules.body));
				return;
			}
			if (req.method === "POST" && req.url === "/internal/extract") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						filename: "thesis.pdf",
						content_type: "application/pdf",
						page_count: 1,
						pages: [
							{ page_number: 1, section_title: "CAPÍTULO 1", text: "excerpt" },
						],
						full_text: "Live wiring integration test thesis excerpt.",
						// document-structure-extraction (precise-thesis-review-pipeline
						// PR1): a real section spanning the document's one page, so this
						// test can prove the orchestrator wires real, non-null
						// document_page_id/document_section_id foreign keys.
						sections: [
							{
								index: 0,
								parent_index: null,
								section_type: "chapter",
								title: "CAPÍTULO 1",
								normalized_title: "capitulo 1",
								start_page_number: 1,
								end_page_number: 1,
								start_offset: 0,
								end_offset: 10,
								is_location_uncertain: false,
								metadata: { detector: "heading_heuristic", confidence: 0.95 },
							},
						],
					}),
				);
				return;
			}
			if (req.method === "POST" && req.url === "/internal/review") {
				res.writeHead(nextReview.status, {
					"content-type": "application/json",
				});
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
				setNextRules(status, body) {
					nextRules = { status, body };
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

test("live HTTP review-run route drives the real pipeline end to end for genuinely uploaded documents, and leaves fabricated ids on the stub path", async (t) => {
	const probeClient = await connectOrSkip(t);
	if (!probeClient) return;

	const migrate = await import("../src/db/migrate.mjs");
	await migrate.migrateDown({ client: probeClient }).catch(() => {});
	await migrate.migrateUp({ client: probeClient });
	await probeClient.end();

	process.env.DATABASE_URL = databaseUrl;
	process.env.LLM_PROVIDER_ENCRYPTION_KEY = VALID_ENCRYPTION_KEY;
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

	// Seed and activate one claude provider row so every scenario below
	// (which exercises the worker's response handling, not provider
	// resolution itself) reaches the real worker exactly as before this
	// pass — see the VALID_ENCRYPTION_KEY comment above.
	const providerRepository = createProviderConfigRepository({
		connectionString: databaseUrl,
	});
	const seededProvider = await providerRepository.create({
		providerName: "claude",
		modelId: "claude-sonnet-4-20250514",
		apiKey: "sk-ant-live-integration-fixture-key",
	});
	await providerRepository.activate(seededProvider.id);

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
			body: {
				files: [pdfFile("grounded.pdf")],
				uploaderUserId: 1,
				metadata: {
					student_name: "Grace Hopper",
					thesis_title: "Evidence-First Thesis Review",
				},
			},
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
		// llm-provider-admin Work Unit 8: the completed run's GET response
		// names which provider/model actually handled it (spec's "Backoffice
		// Provider Visibility & Run Provenance" requirement) — the seeded
		// active provider above, resolved end to end through the real
		// pipeline, not fabricated.
		assert.equal(statusRes.body.llm_provider_name, "claude");
		assert.equal(statusRes.body.llm_model_id, "claude-sonnet-4-20250514");

		// TRIANGULATE: a run completed BEFORE this change (NULL provenance
		// columns) must render gracefully — never an error — proving the
		// "unknown provider" fallback is real, not assumed. Simulated here by
		// directly nulling this genuinely-completed run's provenance columns.
		const { default: pg } = await import("pg");
		const provenanceClient = new pg.Client({ connectionString: databaseUrl });
		await provenanceClient.connect();
		await provenanceClient.query(
			"UPDATE review_run SET llm_provider_name = NULL, llm_model_id = NULL WHERE id = $1",
			[
				(await import("../src/live-review-pipeline.mjs"))
					.getLivePipeline()
					.getReviewRunDbId(runId),
			],
		);
		await provenanceClient.end();
		const statusResAfterNulling = await handleApiRequest({
			method: "GET",
			path: `/api/v1/review-runs/${runId}`,
		});
		assert.equal(statusResAfterNulling.status, 200);
		assert.equal(statusResAfterNulling.body.status, "completed");
		assert.equal(statusResAfterNulling.body.llm_provider_name, null);
		assert.equal(statusResAfterNulling.body.llm_model_id, null);

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

		const reportRes = await handleApiRequest({
			method: "GET",
			path: `/api/v1/review-runs/${runId}/report-artifacts`,
		});
		assert.equal(reportRes.status, 200);
		assert.equal(reportRes.body.status, "available");
		assert.equal(reportRes.body.items.length, 1);
		assert.equal(
			reportRes.body.items[0].filename,
			`review-run-${runId}-report.md`,
		);
		assert.equal(
			reportRes.body.items[0].content_type,
			"text/markdown; charset=utf-8",
		);
		assert.match(reportRes.body.items[0].content, /^# Thesis Review Report\n/);
		assert.match(reportRes.body.items[0].content, /## Executive Summary/);
		assert.match(reportRes.body.items[0].content, /Missing APA citation/);

		const boardRes = await handleApiRequest({
			method: "GET",
			path: "/api/v1/review-board/cards",
		});
		assert.equal(boardRes.status, 200);
		const boardCard = boardRes.body.items.find(
			(card) => card.student_name === "Grace Hopper",
		);
		assert.equal(boardCard.thesis_title, "Evidence-First Thesis Review");
		assert.equal(boardCard.priority, "normal");
		assert.equal(boardCard.board_state, "reviewed");
		assert.equal(boardCard.review_run_status, "completed");
		assert.equal(boardCard.report_ready, true);

		const priorityRes = await handleApiRequest({
			method: "PATCH",
			path: `/api/v1/review-board/cards/${boardCard.id}/priority`,
			body: { priority: "urgent" },
		});
		assert.equal(priorityRes.status, 200);
		assert.equal(priorityRes.body.priority, "urgent");
		assert.equal(priorityRes.body.review_run_status, "completed");

		const approvalRes = await handleApiRequest({
			method: "POST",
			path: `/api/v1/review-board/cards/${boardCard.id}/approval`,
			body: { reviewerName: "Dr. Hopper" },
		});
		assert.equal(approvalRes.status, 200);
		assert.equal(approvalRes.body.board_state, "approved");
		assert.equal(approvalRes.body.reviewer_label, "Dr. Hopper");
		assert.match(reportRes.body.items[0].content, /Page 1/);
		assert.match(
			reportRes.body.items[0].content,
			/Live wiring integration test thesis excerpt\./,
		);
		assert.match(
			reportRes.body.items[0].content,
			/Add an APA in-text citation\./,
		);

		// document-structure-extraction (precise-thesis-review-pipeline PR1):
		// the real page/section the fake worker's /internal/extract response
		// carried above are genuinely persisted, and the finding's evidence
		// carries real (non-null) document_page_id/document_section_id FKs —
		// not the `null` every caller passed before this pass.
		const { default: pgForStructure } = await import("pg");
		const structureClient = new pgForStructure.Client({
			connectionString: databaseUrl,
		});
		await structureClient.connect();
		try {
			const runDbId = (await import("../src/live-review-pipeline.mjs"))
				.getLivePipeline()
				.getReviewRunDbId(runId);
			const pageRows = await structureClient.query(
				"SELECT count(*)::int AS count FROM document_page WHERE review_run_id = $1",
				[runDbId],
			);
			assert.equal(pageRows.rows[0].count, 1);
			const sectionRows = await structureClient.query(
				"SELECT count(*)::int AS count FROM document_section WHERE review_run_id = $1",
				[runDbId],
			);
			assert.equal(sectionRows.rows[0].count, 1);
			const evidenceRows = await structureClient.query(
				"SELECT document_page_id, document_section_id FROM evidence_snippet WHERE review_run_id = $1",
				[runDbId],
			);
			assert.equal(evidenceRows.rows.length, 1);
			assert.ok(
				evidenceRows.rows[0].document_page_id != null,
				"finding evidence must carry a real, non-null document_page_id",
			);
			assert.ok(
				evidenceRows.rows[0].document_section_id != null,
				"finding evidence must carry a real, non-null document_section_id",
			);
		} finally {
			await structureClient.end();
		}

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
		// precise-thesis-review-pipeline Work Unit 5 (deliberate, necessary
		// rework — design.md D9): with the deterministic rule engine now an
		// independent path, breaking ONLY /internal/review no longer fails the
		// whole run (the rules path still succeeds -> status='completed' with
		// metadata.partial_failure — see Scenario 4 below, which is exactly
		// that case). This scenario's original intent — "the worker is
		// genuinely broken -> the run fails" — is preserved by breaking BOTH
		// independent endpoints, matching "Both paths fail -> status='failed'
		// (today's behavior, unchanged)" from design.md's own D3 semantics.
		worker.setNextReview(500, {
			detail: "configuration_error: ANTHROPIC_API_KEY is not set",
		});
		worker.setNextRules(500, { detail: "rules engine crashed" });

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

		const failedBoardRes = await handleApiRequest({
			method: "GET",
			path: "/api/v1/review-board/cards",
		});
		const failedBoardCard = failedBoardRes.body.items.find(
			(card) => card.student_name === "failure.pdf",
		);
		assert.equal(failedBoardCard.board_state, "in_review");
		assert.equal(failedBoardCard.review_run_status, "failed");
		assert.match(failedBoardCard.attention_text, /failed/i);

		// --- Scenario 4 (precise-thesis-review-pipeline Work Unit 5): the LLM
		// judgment path is deliberately broken (mirrors Scenario 3), but the
		// deterministic rule engine's independent /internal/rules path still
		// succeeds — its findings MUST still persist with
		// producer_type='deterministic_rule', and the run MUST still reach
		// 'completed' (never 'failed' just because one of the two independent
		// paths errored), per design.md D9 / spec's "Independence from the LLM
		// Review Path". ---
		worker.setNextReview(500, {
			detail: "configuration_error: ANTHROPIC_API_KEY is not set",
		});
		worker.setNextRules(200, {
			findings: [
				{
					finding_type: "writing_style",
					severity: "low",
					confidence: 0.9,
					title: 'Muletilla detectada: "o sea"',
					explanation:
						"Se encontró la muletilla, que debilita el registro académico.",
					recommendation: "Reformule la oración evitando esta muletilla.",
					evidence_text: "o sea",
					page_number: 1,
					section_index: null,
					rule_id: "filler_words.lexicon_match",
					producer_type: "deterministic_rule",
					producer_id: "rules@v1",
					metadata: { filler: "o sea" },
				},
			],
		});

		const uploadRes4 = await handleApiRequest({
			method: "POST",
			path: "/api/v1/thesis-documents",
			body: { files: [pdfFile("partial-failure.pdf")], uploaderUserId: 1 },
		});
		const runRes4 = await handleApiRequest({
			method: "POST",
			path: `/api/v1/thesis-documents/${uploadRes4.body.id}/review-runs`,
			body: {},
		});
		assert.equal(
			runRes4.body.status,
			"completed",
			"one path failing (LLM) must not fail a run whose other path (rules) succeeded",
		);

		const findingsRes4 = await handleApiRequest({
			method: "GET",
			path: `/api/v1/review-runs/${runRes4.body.id}/findings`,
		});
		assert.equal(findingsRes4.body.items.length, 1);
		assert.equal(
			findingsRes4.body.items[0].title,
			'Muletilla detectada: "o sea"',
		);

		const { default: pgForRules } = await import("pg");
		const rulesClient = new pgForRules.Client({
			connectionString: databaseUrl,
		});
		await rulesClient.connect();
		try {
			const runDbId4 = (await import("../src/live-review-pipeline.mjs"))
				.getLivePipeline()
				.getReviewRunDbId(runRes4.body.id);
			const findingRow = await rulesClient.query(
				"SELECT producer_type, rule_id, metadata FROM finding WHERE review_run_id = $1",
				[runDbId4],
			);
			assert.equal(findingRow.rows.length, 1);
			assert.equal(findingRow.rows[0].producer_type, "deterministic_rule");
			assert.equal(findingRow.rows[0].rule_id, "filler_words.lexicon_match");
			assert.equal(findingRow.rows[0].metadata.filler, "o sea");

			const runRow = await rulesClient.query(
				"SELECT metadata FROM review_run WHERE id = $1",
				[runDbId4],
			);
			assert.ok(
				runRow.rows[0].metadata?.partial_failure?.llm,
				"the failed LLM path must be recorded as a partial_failure, not silently dropped",
			);
		} finally {
			await rulesClient.end();
		}

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
});
