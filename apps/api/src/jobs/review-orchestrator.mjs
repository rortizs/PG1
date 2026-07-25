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
 */
export async function defaultRunCagReview({ thesisText }) {
	const response = await fetch(`${DEFAULT_WORKER_BASE_URL}/internal/review`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ thesis_text: thesisText }),
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

	return async function process(payload) {
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
}

/**
 * Assembles a fully real, ready-to-use review pipeline: a real
 * `review-run-lifecycle.mjs` instance wired to a real `inline-review-queue.mjs`
 * running this module's orchestration processor. `lifecycle.startReviewRun()`
 * on the returned instance drives the whole extract -> CAG review -> persist
 * flow synchronously, matching the spec's "Synchronous Review-Run Trigger"
 * requirement. Not yet wired into `api-contract.mjs`'s live singleton (see
 * apply-progress.md's documented deviation) — this factory is the concrete,
 * tested seam a future controller-wiring step will plug in.
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

	return { lifecycle: lifecycleInstance, queue };
}
