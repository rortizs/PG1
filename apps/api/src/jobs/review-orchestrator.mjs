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
}) {
	const body = { thesis_text: thesisText };
	if (providerName !== undefined) body.provider_name = providerName;
	if (apiKey !== undefined) body.api_key = apiKey;
	if (modelId !== undefined) body.model_id = modelId;
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
	resolveNormativeSourceId,
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
			const thesisDocumentDbId = await resolveThesisDocumentDbId(
				thesisDocumentId,
			);
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
			lifecycle.transitionReviewRun(lifecycleRunId, "validating");
			lifecycle.transitionReviewRun(lifecycleRunId, "rag_reviewing");

			const thesisText = extraction.fullText ?? extraction.full_text ?? "";
			const reviewResult = await runCagReview({ thesisText });
			const finding = reviewResult?.finding ?? null;

			lifecycle.transitionReviewRun(lifecycleRunId, "reporting");

			if (finding) {
				const normativeSourceId = await resolveNormativeSourceId(
					finding.normative_source_ref,
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
					},
					evidence: [
						{
							evidenceText: finding.evidence_text,
							pageNumber: finding.page_number ?? null,
							sectionTitle: finding.section_title ?? null,
							isPageUncertain:
								finding.page_number == null && finding.section_title == null,
						},
					],
				});
			}

			await repository.updateReviewRunStatus(reviewRunDbId, {
				completedAt: new Date(),
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
