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
	const { createReviewRepository } = await import(
		"../src/db/review-repository.mjs"
	);
	const { createReviewPipeline } = await import(
		"../src/jobs/review-orchestrator.mjs"
	);

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

test("review pipeline: grounded CAG result persists exactly one finding with evidence and reaches completed", async (t) => {
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
});

test("review pipeline: ungrounded CAG result yields zero findings and still completes", async (t) => {
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
});

test("review pipeline: a Claude API error transitions the run to failed with an error summary — never fabricates a finding", async (t) => {
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
});

test("orchestrator inserts pages/sections before persisting any finding, and wires real documentPageId/documentSectionId (no live DB needed — a fake repository records call order and arguments)", async () => {
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
});

test("a review run with zero detected sections still persists pages and findings with documentSectionId null — never crashes", async () => {
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

	const sectionsCall = calls.find(
		(c) => c.fn === "insertDocumentSections",
	).args;
	assert.deepEqual(sectionsCall.sections, []);

	const persistCall = calls.find((c) => c.fn === "persistFinding").args;
	assert.equal(persistCall.evidence[0].documentPageId, 211);
	assert.equal(persistCall.evidence[0].documentSectionId, null);
});

test("deterministic rule engine independence: LLM path forced to throw still persists rule findings with producer_type='deterministic_rule', and the run still completes (design.md D9)", async () => {
	const { createReviewOrchestrationProcessor } = await import(
		"../src/jobs/review-orchestrator.mjs"
	);

	const calls = [];
	const statusUpdates = [];
	const repository = {
		insertReviewRun: async () => 103,
		updateReviewRunStatus: async (_id, args) => {
			statusUpdates.push(args);
		},
		insertDocumentPages: async (args) => {
			calls.push({ fn: "insertDocumentPages", args });
			return { ids: [221], idByPageNumber: { 1: 221 } };
		},
		insertDocumentSections: async (args) => {
			calls.push({ fn: "insertDocumentSections", args });
			return { ids: [], idByIndex: {} };
		},
		persistFinding: async (args) => {
			calls.push({ fn: "persistFinding", args });
			return { findingId: 411, evidenceIds: [511] };
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
		runRules: async () => ({
			findings: [
				{
					finding_type: "writing_style",
					severity: "low",
					confidence: 0.9,
					title: "Muletilla detectada",
					explanation: "explanation",
					recommendation: "recommendation",
					evidence_text: "o sea",
					page_number: 1,
					rule_id: "filler_words.lexicon_match",
					producer_type: "deterministic_rule",
					producer_id: "rules@v1",
					metadata: {},
				},
			],
		}),
		runCagReview: async () => {
			throw new Error("Claude API timeout");
		},
		resolveNormativeSourceId: async () => null,
	});

	await processor({ review_run_id: "run_3", thesis_document_id: "doc_3" });

	const persistCalls = calls.filter((c) => c.fn === "persistFinding");
	assert.equal(persistCalls.length, 1);
	assert.equal(persistCalls[0].args.finding.producerType, "deterministic_rule");
	assert.equal(
		persistCalls[0].args.finding.ruleId,
		"filler_words.lexicon_match",
	);

	// The run must still complete (only ONE of the two independent paths
	// failed) — never fabricated as "failed" just because the LLM path
	// errored out.
	const completionUpdate = statusUpdates.find((u) => u.completedAt);
	assert.ok(completionUpdate, "expected a completedAt status update");
	assert.ok(completionUpdate.metadata?.partial_failure?.llm);
});

test("deterministic rule engine independence, inverse: rule engine failure still persists the LLM finding and the run still completes", async () => {
	const { createReviewOrchestrationProcessor } = await import(
		"../src/jobs/review-orchestrator.mjs"
	);

	const calls = [];
	const statusUpdates = [];
	const repository = {
		insertReviewRun: async () => 104,
		updateReviewRunStatus: async (_id, args) => {
			statusUpdates.push(args);
		},
		insertDocumentPages: async (args) => {
			calls.push({ fn: "insertDocumentPages", args });
			return { ids: [222], idByPageNumber: { 1: 222 } };
		},
		insertDocumentSections: async (args) => {
			calls.push({ fn: "insertDocumentSections", args });
			return { ids: [], idByIndex: {} };
		},
		persistFinding: async (args) => {
			calls.push({ fn: "persistFinding", args });
			return { findingId: 412, evidenceIds: [512] };
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
		runRules: async () => {
			throw new Error("worker /internal/rules unreachable");
		},
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

	await processor({ review_run_id: "run_4", thesis_document_id: "doc_4" });

	const persistCalls = calls.filter((c) => c.fn === "persistFinding");
	assert.equal(persistCalls.length, 1);
	assert.equal(persistCalls[0].args.finding.producerType, "controlled_rag");

	const completionUpdate = statusUpdates.find((u) => u.completedAt);
	assert.ok(completionUpdate, "expected a completedAt status update");
	assert.ok(completionUpdate.metadata?.partial_failure?.rules);
});

test("deterministic rule engine independence: both paths failing still transitions the run to failed (today's behavior, unchanged)", async () => {
	const { createReviewOrchestrationProcessor } = await import(
		"../src/jobs/review-orchestrator.mjs"
	);

	const repository = {
		insertReviewRun: async () => 105,
		updateReviewRunStatus: async () => {},
		insertDocumentPages: async () => ({
			ids: [223],
			idByPageNumber: { 1: 223 },
		}),
		insertDocumentSections: async () => ({ ids: [], idByIndex: {} }),
		persistFinding: async () => ({ findingId: 413, evidenceIds: [513] }),
	};
	const failedJobs = [];
	const lifecycle = {
		transitionReviewRun: () => {},
		markJobFailed: (id, details) => failedJobs.push({ id, details }),
	};

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
		runRules: async () => {
			throw new Error("worker /internal/rules unreachable");
		},
		runCagReview: async () => {
			throw new Error("Claude API timeout");
		},
		resolveNormativeSourceId: async () => null,
	});

	await processor({ review_run_id: "run_5", thesis_document_id: "doc_5" });

	assert.equal(failedJobs.length, 1);
	assert.match(failedJobs[0].details.message, /Claude API timeout/);
});

test("orchestrator sends llm_text to CAG review while preserving original pages and sections for rules", async () => {
	const { createReviewOrchestrationProcessor } = await import(
		"../src/jobs/review-orchestrator.mjs"
	);

	let rulesPayload = null;
	let reviewedThesisText = null;
	const pages = [
		{ page_number: 1, section_title: null, text: "Original page text." },
	];
	const sections = [
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
			metadata: { detector: "heading_heuristic" },
		},
	];
	const repository = {
		insertReviewRun: async () => 106,
		updateReviewRunStatus: async () => {},
		insertDocumentPages: async () => ({
			ids: [224],
			idByPageNumber: { 1: 224 },
		}),
		insertDocumentSections: async () => ({ ids: [314], idByIndex: { 0: 314 } }),
		persistFinding: async () => ({ findingId: 414, evidenceIds: [514] }),
	};
	const lifecycle = { transitionReviewRun: () => {}, markJobFailed: () => {} };

	const processor = createReviewOrchestrationProcessor({
		repository,
		lifecycle,
		resolveThesisDocumentDbId: async () => 1,
		extractThesisText: async () => ({
			fullText: "Legacy full text.",
			llm_text: "Markdown text for the LLM.",
			pages,
			sections,
			content_type: "application/pdf",
		}),
		runRules: async (payload) => {
			rulesPayload = payload;
			return { findings: [] };
		},
		runCagReview: async ({ thesisText }) => {
			reviewedThesisText = thesisText;
			return { finding: null };
		},
		resolveNormativeSourceId: async () => null,
	});

	await processor({ review_run_id: "run_6", thesis_document_id: "doc_6" });

	assert.equal(reviewedThesisText, "Markdown text for the LLM.");
	assert.deepEqual(rulesPayload, { pages, sections });
});

test("orchestrator injects retrieved normative context into CAG review and persists retrieval provenance", async () => {
	const { createReviewOrchestrationProcessor } = await import(
		"../src/jobs/review-orchestrator.mjs"
	);

	let reviewedArgs = null;
	let persistedFinding = null;
	const retrievedContext = [
		{
			segment_id: 7,
			source_ref: "guide.txt",
			segment_text: "APA citation rules require references.",
			similarity_score: 0.03,
		},
	];
	const repository = {
		insertReviewRun: async () => 107,
		updateReviewRunStatus: async () => {},
		insertDocumentPages: async () => ({
			ids: [225],
			idByPageNumber: { 1: 225 },
		}),
		insertDocumentSections: async () => ({ ids: [], idByIndex: {} }),
		persistFinding: async (args) => {
			persistedFinding = args.finding;
			return { findingId: 415, evidenceIds: [515] };
		},
	};
	const processor = createReviewOrchestrationProcessor({
		repository,
		lifecycle: { transitionReviewRun: () => {}, markJobFailed: () => {} },
		resolveThesisDocumentDbId: async () => 1,
		extractThesisText: async () => ({
			fullText: "The thesis omits APA citation details.",
			pages: [
				{ page_number: 1, text: "The thesis omits APA citation details." },
			],
			sections: [],
			content_type: "application/pdf",
		}),
		retrieveNormativeContext: async ({ thesisText }) => {
			assert.match(thesisText, /APA citation/);
			return retrievedContext;
		},
		runCagReview: async (args) => {
			reviewedArgs = args;
			return {
				finding: {
					title: "Missing APA citation",
					explanation: "Paraphrases without citing.",
					recommendation: "Add a citation.",
					evidence_text: "The thesis omits APA citation details.",
					page_number: 1,
					section_title: null,
					normative_source_ref: "guide.txt",
					producer_id: "claude-fake",
				},
			};
		},
		resolveNormativeSourceId: async () => null,
	});

	await processor({ review_run_id: "run_7", thesis_document_id: "doc_7" });

	assert.deepEqual(reviewedArgs.retrievedContext, retrievedContext);
	assert.equal(persistedFinding.metadata.rag_context.mode, "retrieved");
	assert.deepEqual(persistedFinding.metadata.rag_context.segment_ids, [7]);
});

test("orchestrator falls back to full-corpus CAG without retrieved-context provenance when retrieval is unavailable", async () => {
	const { createReviewOrchestrationProcessor } = await import(
		"../src/jobs/review-orchestrator.mjs"
	);

	let reviewedArgs = null;
	let persistedFinding = null;
	const repository = {
		insertReviewRun: async () => 108,
		updateReviewRunStatus: async () => {},
		insertDocumentPages: async () => ({
			ids: [226],
			idByPageNumber: { 1: 226 },
		}),
		insertDocumentSections: async () => ({ ids: [], idByIndex: {} }),
		persistFinding: async (args) => {
			persistedFinding = args.finding;
			return { findingId: 416, evidenceIds: [516] };
		},
	};
	const processor = createReviewOrchestrationProcessor({
		repository,
		lifecycle: { transitionReviewRun: () => {}, markJobFailed: () => {} },
		resolveThesisDocumentDbId: async () => 1,
		extractThesisText: async () => ({
			fullText: "The thesis text still receives CAG fallback.",
			pages: [
				{
					page_number: 1,
					text: "The thesis text still receives CAG fallback.",
				},
			],
			sections: [],
			content_type: "application/pdf",
		}),
		retrieveNormativeContext: async () => {
			throw new Error("embedding provider unavailable");
		},
		runCagReview: async (args) => {
			reviewedArgs = args;
			return {
				finding: {
					title: "Fallback CAG finding",
					explanation: "Full-corpus review still runs.",
					recommendation: "Use the full corpus.",
					evidence_text: "The thesis text still receives CAG fallback.",
					page_number: 1,
					section_title: null,
					normative_source_ref: "guide.txt",
					producer_id: "claude-fake",
				},
			};
		},
		resolveNormativeSourceId: async () => null,
	});

	await processor({ review_run_id: "run_8", thesis_document_id: "doc_8" });

	assert.equal(reviewedArgs.retrievedContext, undefined);
	assert.equal(persistedFinding.metadata?.rag_context, undefined);
});

test("defaultRunCagReview forwards provider_name/api_key/model_id to the worker when supplied, and omits them entirely when not (backward compatible)", async () => {
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

		await defaultRunCagReview({
			thesisText: "Some excerpt needing retrieved context.",
			retrievedContext: [
				{
					segment_id: 7,
					source_ref: "guide.txt",
					segment_text: "APA citation rules require references.",
					similarity_score: 0.03,
				},
			],
		});
		assert.deepEqual(worker.getLastBody(), {
			thesis_text: "Some excerpt needing retrieved context.",
			rag_context: [
				{
					segment_id: 7,
					source_ref: "guide.txt",
					segment_text: "APA citation rules require references.",
					similarity_score: 0.03,
				},
			],
		});
	} finally {
		if (previousWorkerBaseUrl === undefined) delete process.env.WORKER_BASE_URL;
		else process.env.WORKER_BASE_URL = previousWorkerBaseUrl;
		await worker.close();
	}
});
