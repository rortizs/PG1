import { createMemoryReviewQueue } from "../jobs/review-queue.mjs";

export const ALLOWED_REVIEW_RUN_STATUSES = [
	"queued",
	"extracting",
	"segmenting",
	"validating",
	"rag_reviewing",
	"reporting",
	"completed",
	"failed",
	"cancelled",
];

const NEXT_STATUSES = {
	queued: new Set(["extracting", "cancelled", "failed"]),
	extracting: new Set(["segmenting", "cancelled", "failed"]),
	segmenting: new Set(["validating", "cancelled", "failed"]),
	validating: new Set(["rag_reviewing", "reporting", "cancelled", "failed"]),
	rag_reviewing: new Set(["reporting", "cancelled", "failed"]),
	reporting: new Set(["completed", "cancelled", "failed"]),
	completed: new Set(),
	failed: new Set(),
	cancelled: new Set(),
};

export function createReviewRunLifecycleService({
	queue = createMemoryReviewQueue(),
} = {}) {
	const reviewRunsById = new Map();
	const idempotencyIndex = new Map();
	const documentPipelineIndex = new Map();
	const auditEvents = [];

	return {
		async startReviewRun({ documentId, pipelineVersion = "pipeline-v1" }) {
			const runId = resolveRunId({
				documentPipelineIndex,
				documentId,
				pipelineVersion,
			});
			const idempotencyKey = buildIdempotencyKey({
				runId,
				stage: "extract",
				pipelineVersion,
			});
			if (idempotencyIndex.has(idempotencyKey)) {
				return accepted(
					reviewRunsById.get(idempotencyIndex.get(idempotencyKey)),
					idempotencyKey,
				);
			}

			const run = {
				id: runId,
				type: "review_run",
				thesis_document_id: documentId,
				status: "queued",
				progress_stage: "queued",
				pipeline_version: pipelineVersion,
				error_summary: null,
				created_at: now(),
				started_at: null,
				completed_at: null,
				failed_at: null,
				status_url: `/api/v1/review-runs/${runId}`,
			};
			reviewRunsById.set(run.id, run);
			idempotencyIndex.set(idempotencyKey, run.id);
			audit(auditEvents, run, "review_run.created", { status: run.status });
			await queue.add(
				"review.extract",
				{
					review_run_id: run.id,
					thesis_document_id: documentId,
					pipeline_version: pipelineVersion,
				},
				{ idempotencyKey, attempts: 3 },
			);
			audit(auditEvents, run, "review_run.job_enqueued", {
				stage: "extract",
				idempotency_key: idempotencyKey,
			});
			return accepted(run, idempotencyKey);
		},

		getReviewRun(runId) {
			return { status: 200, body: clone(requireRun(reviewRunsById, runId)) };
		},

		transitionReviewRun(runId, nextStatus) {
			const run = requireRun(reviewRunsById, runId);
			assertAllowedTransition(run.status, nextStatus);
			const previousStatus = run.status;
			run.status = nextStatus;
			run.progress_stage = nextStatus;
			if (nextStatus === "completed") run.completed_at = now();
			audit(auditEvents, run, "review_run.status_changed", {
				from: previousStatus,
				to: nextStatus,
			});
			return { status: 200, body: clone(run) };
		},

		cancelReviewRun(runId, reason = "Review run cancelled.") {
			const run = requireRun(reviewRunsById, runId);
			assertAllowedTransition(run.status, "cancelled");
			run.status = "cancelled";
			run.progress_stage = "cancelled";
			run.error_summary = reason;
			audit(auditEvents, run, "review_run.cancelled", { reason });
			return { status: 200, body: clone(run) };
		},

		markJobFailed(runId, { stage, message }) {
			const run = requireRun(reviewRunsById, runId);
			assertAllowedTransition(run.status, "failed");
			run.status = "failed";
			run.progress_stage = "failed";
			run.error_summary = `${stage} failed: ${message}`;
			run.failed_at = now();
			audit(auditEvents, run, "review_run.failed", { stage, message });
			return { status: 200, body: clone(run) };
		},

		reviewRuns() {
			return [...reviewRunsById.values()].map(clone);
		},
		auditEvents() {
			return auditEvents.map(clone);
		},
	};
}

export function buildIdempotencyKey({ runId, stage, pipelineVersion }) {
	return `review_run:${runId}:${stage}:${pipelineVersion}`;
}

function resolveRunId({ documentPipelineIndex, documentId, pipelineVersion }) {
	const pipelineByDocument = documentPipelineIndex.get(documentId) ?? new Map();
	if (pipelineByDocument.has(pipelineVersion)) {
		return pipelineByDocument.get(pipelineVersion);
	}
	const preferredRunId =
		pipelineByDocument.size === 0
			? `run_${documentId}`
			: `run_${documentId}_${pipelineByDocument.size + 1}`;
	const runId = uniqueRunId(preferredRunId, documentPipelineIndex);
	pipelineByDocument.set(pipelineVersion, runId);
	documentPipelineIndex.set(documentId, pipelineByDocument);
	return runId;
}

function uniqueRunId(preferredRunId, documentPipelineIndex) {
	const existingRunIds = new Set(
		[...documentPipelineIndex.values()].flatMap((pipelineByDocument) => [
			...pipelineByDocument.values(),
		]),
	);
	if (!existingRunIds.has(preferredRunId)) return preferredRunId;
	let suffix = 2;
	let candidate = `${preferredRunId}_${suffix}`;
	while (existingRunIds.has(candidate)) {
		suffix += 1;
		candidate = `${preferredRunId}_${suffix}`;
	}
	return candidate;
}

function accepted(run, idempotencyKey) {
	return {
		status: 202,
		body: { ...clone(run), idempotency_key: idempotencyKey },
	};
}

function assertAllowedTransition(currentStatus, nextStatus) {
	if (
		!ALLOWED_REVIEW_RUN_STATUSES.includes(nextStatus) ||
		!NEXT_STATUSES[currentStatus]?.has(nextStatus)
	) {
		throw new Error(
			`Invalid review-run status transition: ${currentStatus} -> ${nextStatus}`,
		);
	}
}

function requireRun(reviewRunsById, runId) {
	const run = reviewRunsById.get(runId);
	if (!run) throw new Error(`Review run not found: ${runId}`);
	return run;
}

function audit(auditEvents, run, eventType, metadata = {}) {
	auditEvents.push({
		entity_type: "review_run",
		entity_id: run.id,
		event_type: eventType,
		message: eventType,
		metadata,
		created_at: now(),
	});
}

function now() {
	return new Date(0).toISOString();
}

function clone(value) {
	return structuredClone(value);
}
