import { createReviewRunLifecycleService } from "../review-runs/review-run-lifecycle.mjs";
import { createInlineReviewQueue } from "./inline-review-queue.mjs";

const DEFAULT_WORKER_BASE_URL =
	process.env.WORKER_BASE_URL ?? "http://localhost:8000";
const DEFAULT_WORKER_TIMEOUT_MS = 30_000;

/**
 * Real (production-shaped) call to the worker's `/internal/review` — the
 * only default HTTP integration provided out of the box, since it needs no
 * document-byte plumbing. `extractThesisText` intentionally has NO default:
 * fetching real stored bytes and POSTing them to `/internal/extract` is the
 * live-storage wiring step deferred to the controller-integration follow-up
 * (see apply-progress.md) — every caller of `createReviewPipeline` must
 * supply its own `extractThesisText` today (a real implementation for
 * production, a fake for tests).
 *
 * llm-provider-admin (Work Unit 5): `providerName`/`apiKey`/`modelId` are
 * the DB-resolved active provider's fields, forwarded by
 * `live-review-pipeline.mjs`'s custom `runCagReview` closure. All three are
 * OPTIONAL and only included in the request body when actually supplied —
 * omitting them keeps the pre-existing Claude+`ANTHROPIC_API_KEY`-env-var
 * worker behavior unchanged (design decision #11: rollback + local dev).
 * Never logged; forwarded only in this internal API->worker request body,
 * the same trust boundary as `WORKER_BASE_URL` itself.
 */
export async function defaultRunCagReview({
	thesisText,
	providerName,
	apiKey,
	modelId,
	retrievedContext,
}) {
	const body = { thesis_text: thesisText };
	if (providerName !== undefined) body.provider_name = providerName;
	if (apiKey !== undefined) body.api_key = apiKey;
	if (modelId !== undefined) body.model_id = modelId;
	if (Array.isArray(retrievedContext) && retrievedContext.length > 0) {
		body.rag_context = retrievedContext;
	}
	const response = await fetch(`${DEFAULT_WORKER_BASE_URL}/internal/review`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(DEFAULT_WORKER_TIMEOUT_MS),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Worker /internal/review failed with status ${response.status}: ${detail}`,
		);
	}
	return response.json();
}

/**
 * Real call to the worker's `/internal/rules` — the deterministic,
 * zero-LLM-call rule engine (design.md D8/D9, precise-thesis-review-pipeline
 * Work Unit 5). Structurally independent of `/internal/review`: it's a
 * separate route, a separate fetch, and (per `process()` below) a separate
 * try/catch, so a failure here never blocks or corrupts the LLM review path,
 * and vice versa (spec: Independence from the LLM Review Path).
 */
export async function defaultRunRules({ pages, sections }) {
	const response = await fetch(`${DEFAULT_WORKER_BASE_URL}/internal/rules`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ pages, sections }),
		signal: AbortSignal.timeout(DEFAULT_WORKER_TIMEOUT_MS),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Worker /internal/rules failed with status ${response.status}: ${detail}`,
		);
	}
	return response.json();
}

/**
 * Picks the most specific (smallest page-span) inserted section whose real
 * page range contains `pageNumber` — used to resolve a finding's
 * `documentSectionId` for the current (pre-chunked, PR1) single-finding
 * review path, which reports `page_number`/`section_title` but not yet a
 * `section_index` (that field is introduced by the chunked review loop,
 * design.md's Work Unit 8 / PR5). `sections` is `{ id, startPageNumber,
 * endPageNumber }[]`. Returns `null` when no section covers the page (or
 * `pageNumber` itself is `null`) — never guesses.
 */
function findSectionIdForPage(sections, pageNumber) {
	if (pageNumber == null) return null;
	let bestId = null;
	let bestSpan = Infinity;
	for (const section of sections) {
		if (section.id == null || section.startPageNumber == null) continue;
		const start = section.startPageNumber;
		const end = section.endPageNumber ?? start;
		if (pageNumber < start || pageNumber > end) continue;
		const span = end - start;
		if (span < bestSpan) {
			bestId = section.id;
			bestSpan = span;
		}
	}
	return bestId;
}

/**
 * Builds the synchronous processor that drives one review run end to end:
 * extract -> CAG review -> persist. Never rethrows — any failure (worker
 * unreachable, Claude error/timeout, malformed provider response) is
 * recorded on the `review_run` row and via `lifecycle.markJobFailed`, so
 * `inline-review-queue.mjs`'s `add()` always resolves and the triggering
 * request completes, matching the spec's "no silent no-op" requirement.
 */
export function createReviewOrchestrationProcessor({
	repository,
	lifecycle,
	resolveThesisDocumentDbId,
	extractThesisText,
	runCagReview = defaultRunCagReview,
	runRules = defaultRunRules,
	resolveNormativeSourceId,
	retrieveNormativeContext,
}) {
	if (typeof extractThesisText !== "function") {
		throw new TypeError(
			"createReviewOrchestrationProcessor requires an `extractThesisText` function.",
		);
	}

	const reviewRunDbIdByLifecycleId = new Map();

	const process = async function process(payload) {
		const {
			review_run_id: lifecycleRunId,
			thesis_document_id: thesisDocumentId,
			pipeline_version: pipelineVersion,
		} = payload;

		let reviewRunDbId;
		try {
			const thesisDocumentDbId =
				await resolveThesisDocumentDbId(thesisDocumentId);
			reviewRunDbId = await repository.insertReviewRun({
				thesisDocumentId: thesisDocumentDbId,
				pipelineVersion,
				status: "queued",
			});
			reviewRunDbIdByLifecycleId.set(lifecycleRunId, reviewRunDbId);
			await repository.updateReviewRunStatus(reviewRunDbId, {
				startedAt: new Date(),
			});

			lifecycle.transitionReviewRun(lifecycleRunId, "extracting");
			const extraction = await extractThesisText({ thesisDocumentId });

			lifecycle.transitionReviewRun(lifecycleRunId, "segmenting");

			// Document Structure Extraction (precise-thesis-review-pipeline PR1):
			// real `document_page`/`document_section` rows are persisted BEFORE
			// any finding, so `persistFinding`'s optional `documentPageId`/
			// `documentSectionId` params can be wired to real FK ids instead of
			// the `null` every caller passed before this pass. `extraction.pages`/
			// `.sections` are absent/empty for callers that don't yet report
			// structure (e.g. every pre-existing fake `extractThesisText` in this
			// test suite) — both inserts safely no-op on an empty array, never a
			// crash (design.md's "zero detected sections still persists pages and
			// findings with documentSectionId: null" requirement).
			const extractionPages = extraction.pages ?? [];
			const extractionSections = extraction.sections ?? [];
			const extractionMethod =
				extraction.content_type === "application/pdf" ? "pdf_text" : "docx";

			const { idByPageNumber } = await repository.insertDocumentPages({
				reviewRunId: reviewRunDbId,
				thesisDocumentId: thesisDocumentDbId,
				pages: extractionPages.map((page) => ({
					pageNumber: page.page_number ?? null,
					text: page.text ?? "",
				})),
				extractionMethod,
			});

			const { idByIndex } = await repository.insertDocumentSections({
				reviewRunId: reviewRunDbId,
				sections: extractionSections.map((section) => ({
					index: section.index,
					parentIndex: section.parent_index ?? null,
					sectionType: section.section_type,
					title: section.title ?? null,
					normalizedTitle: section.normalized_title ?? null,
					startPageNumber: section.start_page_number ?? null,
					endPageNumber: section.end_page_number ?? null,
					startOffset: section.start_offset ?? null,
					endOffset: section.end_offset ?? null,
					isLocationUncertain: Boolean(section.is_location_uncertain),
					metadata: section.metadata ?? {},
				})),
			});
			const insertedSections = extractionSections.map((section) => ({
				id: idByIndex[section.index] ?? null,
				startPageNumber: section.start_page_number ?? null,
				endPageNumber: section.end_page_number ?? null,
			}));

			lifecycle.transitionReviewRun(lifecycleRunId, "validating");

			// Deterministic rules + LLM review (precise-thesis-review-pipeline
			// Work Unit 5, design.md D9): the two paths are called and persisted
			// INDEPENDENTLY — a failure in either one is caught here, never
			// re-thrown, so it can never block or corrupt the other's result set
			// (spec: Independence from the LLM Review Path). Both failing (or
			// extraction itself failing, handled by the outer try/catch) is the
			// only case that still fails the whole run.
			let ruleFindings = [];
			let ruleError = null;
			try {
				const rulesResult = await runRules({
					pages: extractionPages,
					sections: extractionSections,
				});
				ruleFindings = rulesResult?.findings ?? [];
			} catch (error) {
				ruleError = error;
			}

			for (const ruleFinding of ruleFindings) {
				const documentPageId =
					ruleFinding.page_number != null
						? (idByPageNumber[ruleFinding.page_number] ?? null)
						: null;
				const documentSectionId = findSectionIdForPage(
					insertedSections,
					ruleFinding.page_number ?? null,
				);
				// thesis-normative-governance design.md D4: resolves the rule
				// engine's declared `normative_source_type` (stamped by
				// `run_rules()`, worker-side) to a real `normative_source.id` —
				// replaces the previous hardcoded `null`. A finding whose type
				// resolves to no row (defensive/unseeded-DB case) still
				// persists with `normativeSourceId: null` rather than throwing.
				const normativeSourceId = await resolveNormativeSourceId(
					ruleFinding.normative_source_type,
				);
				await repository.persistFinding({
					reviewRunId: reviewRunDbId,
					normativeSourceId,
					finding: {
						findingType: ruleFinding.finding_type,
						severity: ruleFinding.severity,
						confidence: ruleFinding.confidence ?? null,
						title: ruleFinding.title,
						explanation: ruleFinding.explanation,
						recommendation: ruleFinding.recommendation ?? null,
						producerType: ruleFinding.producer_type ?? "deterministic_rule",
						producerId: ruleFinding.producer_id ?? "rules@v1",
						ruleId: ruleFinding.rule_id ?? null,
						metadata: ruleFinding.metadata ?? {},
					},
					evidence: [
						{
							evidenceText: ruleFinding.evidence_text,
							pageNumber: ruleFinding.page_number ?? null,
							sectionTitle: null,
							documentPageId,
							documentSectionId,
							isPageUncertain: ruleFinding.page_number == null,
						},
					],
				});
			}

			lifecycle.transitionReviewRun(lifecycleRunId, "rag_reviewing");

			let reviewResult = null;
			let llmError = null;
			let retrievedContext = [];
			try {
				const thesisText =
					extraction.llm_text ??
					extraction.llmText ??
					extraction.fullText ??
					extraction.full_text ??
					"";
				if (typeof retrieveNormativeContext === "function") {
					try {
						const retrieved = await retrieveNormativeContext({ thesisText });
						retrievedContext = Array.isArray(retrieved) ? retrieved : [];
					} catch {
						retrievedContext = [];
					}
				}
				reviewResult = await runCagReview({
					thesisText,
					...(retrievedContext.length > 0 ? { retrievedContext } : {}),
				});
			} catch (error) {
				llmError = error;
			}
			const finding = reviewResult?.finding ?? null;

			lifecycle.transitionReviewRun(lifecycleRunId, "reporting");

			if (finding) {
				const normativeSourceId = await resolveNormativeSourceId(
					finding.normative_source_ref,
				);
				const documentPageId =
					finding.page_number != null
						? (idByPageNumber[finding.page_number] ?? null)
						: null;
				const documentSectionId = findSectionIdForPage(
					insertedSections,
					finding.page_number ?? null,
				);
				await repository.persistFinding({
					reviewRunId: reviewRunDbId,
					normativeSourceId,
					finding: {
						findingType: finding.finding_type ?? "rag_review",
						severity: finding.severity ?? "medium",
						confidence: finding.confidence ?? null,
						title: finding.title,
						explanation: finding.explanation,
						recommendation: finding.recommendation ?? null,
						producerType: finding.producer_type ?? "controlled_rag",
						producerId: finding.producer_id,
						metadata:
							retrievedContext.length > 0
								? {
										rag_context: {
											mode: "retrieved",
											segment_ids: retrievedContext.map(
												(item) => item.segment_id,
											),
											source_refs: retrievedContext.map(
												(item) => item.source_ref,
											),
										},
									}
								: {},
					},
					evidence: [
						{
							evidenceText: finding.evidence_text,
							pageNumber: finding.page_number ?? null,
							sectionTitle: finding.section_title ?? null,
							documentPageId,
							documentSectionId,
							isPageUncertain:
								finding.page_number == null && finding.section_title == null,
						},
					],
				});
			}

			// Both independent paths failing is treated exactly like today's
			// single-path failure: rethrow so the outer catch marks the run
			// `failed` with a real `error_summary` (design.md D3's partial-failure
			// semantics — "Both paths fail ... -> status='failed' (today's
			// behavior, unchanged)").
			if (ruleError && llmError) {
				throw new Error(
					`review pipeline failed on both independent paths — rules: ${ruleError.message}; llm: ${llmError.message}`,
				);
			}

			const partialFailure = {};
			if (ruleError) partialFailure.rules = ruleError.message;
			if (llmError) partialFailure.llm = llmError.message;
			const hasPartialFailure = Object.keys(partialFailure).length > 0;

			await repository.updateReviewRunStatus(reviewRunDbId, {
				completedAt: new Date(),
				// llm-provider-admin Work Unit 8: `runCagReview`'s result MAY carry
				// which provider actually produced it (`live-review-pipeline.mjs`'s
				// `runCagReviewWithActiveProvider` augments its result with these
				// two fields) — persisted onto the completed review_run so the
				// admin/results views can show provenance. `undefined` (a
				// `runCagReview` implementation that doesn't know/report this,
				// e.g. every existing test's fake worker) safely no-ops via
				// `updateReviewRunStatus`'s own `COALESCE`.
				llmProviderName: reviewResult?.providerName ?? null,
				llmModelId: reviewResult?.modelId ?? null,
				// design.md D3: "LLM path fails but rules succeeded (or vice versa)
				// -> status='completed', error_summary=<failed path message>,
				// metadata.partial_failure={llm|rules: message}."
				errorSummary: hasPartialFailure
					? (ruleError?.message ?? llmError?.message)
					: null,
				metadata: hasPartialFailure
					? { partial_failure: partialFailure }
					: undefined,
			});
			lifecycle.transitionReviewRun(lifecycleRunId, "completed");
		} catch (error) {
			if (reviewRunDbId) {
				await repository
					.updateReviewRunStatus(reviewRunDbId, {
						failedAt: new Date(),
						errorSummary: error.message,
					})
					.catch(() => {});
			}
			lifecycle.markJobFailed(lifecycleRunId, {
				stage: "review",
				message: error.message,
			});
		}
	};

	// Exposed so `createReviewPipeline` can map an external lifecycle run id
	// back to its internal Postgres `review_run.id` (needed to read persisted
	// findings for that run) without changing `process`'s plain-function
	// call shape expected by `inline-review-queue.mjs`.
	process.reviewRunDbIdByLifecycleId = reviewRunDbIdByLifecycleId;
	return process;
}

/**
 * Assembles a fully real, ready-to-use review pipeline: a real
 * `review-run-lifecycle.mjs` instance wired to a real `inline-review-queue.mjs`
 * running this module's orchestration processor. `lifecycle.startReviewRun()`
 * on the returned instance drives the whole extract -> CAG review -> persist
 * flow synchronously, matching the spec's "Synchronous Review-Run Trigger"
 * requirement. Wired into `api-contract.mjs`'s live HTTP path (via
 * `live-review-pipeline.mjs`) for genuinely uploaded documents only — see
 * apply-progress.md's "Live HTTP Wiring" section for the real-vs-stub
 * routing rationale.
 */
export function createReviewPipeline({
	repository,
	resolveThesisDocumentDbId,
	extractThesisText,
	runCagReview = defaultRunCagReview,
	resolveNormativeSourceId,
	retrieveNormativeContext,
}) {
	let lifecycleInstance;
	const lifecycleProxy = {
		transitionReviewRun: (...args) =>
			lifecycleInstance.transitionReviewRun(...args),
		markJobFailed: (...args) => lifecycleInstance.markJobFailed(...args),
	};

	const processor = createReviewOrchestrationProcessor({
		repository,
		lifecycle: lifecycleProxy,
		resolveThesisDocumentDbId,
		extractThesisText,
		runCagReview,
		resolveNormativeSourceId,
		retrieveNormativeContext,
	});
	const queue = createInlineReviewQueue({ processor });
	lifecycleInstance = createReviewRunLifecycleService({ queue });

	return {
		lifecycle: lifecycleInstance,
		queue,
		repository,
		// Maps an external lifecycle run id (e.g. `run_doc_abc`) to the
		// internal Postgres `review_run.id` written by this pipeline's
		// processor — lets a caller (e.g. the live HTTP wiring) read back
		// persisted findings for a run without re-deriving the mapping.
		getReviewRunDbId: (lifecycleRunId) =>
			processor.reviewRunDbIdByLifecycleId.get(lifecycleRunId) ?? null,
	};
}
