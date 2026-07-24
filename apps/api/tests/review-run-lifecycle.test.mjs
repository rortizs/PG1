import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ALLOWED_REVIEW_RUN_STATUSES,
	createReviewRunLifecycleService,
} from "../src/review-runs/review-run-lifecycle.mjs";
import { createMemoryReviewQueue } from "../src/jobs/review-queue.mjs";

const EXPECTED_STATUSES = [
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

function createService() {
	const queue = createMemoryReviewQueue();
	const service = createReviewRunLifecycleService({ queue });
	return { service, queue };
}

test("review-run lifecycle centralizes the exact allowed statuses", () => {
	assert.deepEqual(ALLOWED_REVIEW_RUN_STATUSES, EXPECTED_STATUSES);
});

test("starting a review run returns 202, creates queued run, enqueues extraction job, and audits lifecycle", async () => {
	const { service, queue } = createService();

	const response = await service.startReviewRun({
		documentId: "doc_uploaded",
		pipelineVersion: "pipeline-v1",
	});

	assert.equal(response.status, 202);
	assert.equal(response.body.type, "review_run");
	assert.equal(response.body.thesis_document_id, "doc_uploaded");
	assert.equal(response.body.status, "queued");
	assert.match(response.body.status_url, /^\/api\/v1\/review-runs\/run_/);
	assert.equal(
		response.body.idempotency_key,
		"review_run:run_doc_uploaded:extract:pipeline-v1",
	);

	assert.deepEqual(
		queue.jobs().map((job) => job.name),
		["review.extract"],
	);
	assert.equal(queue.jobs()[0].idempotencyKey, response.body.idempotency_key);
	assert.deepEqual(
		service.auditEvents().map((event) => event.event_type),
		["review_run.created", "review_run.job_enqueued"],
	);
});

test("repeated starts with the same idempotency key do not duplicate runs or jobs", async () => {
	const { service, queue } = createService();

	const first = await service.startReviewRun({
		documentId: "doc_same",
		pipelineVersion: "v1",
	});
	const second = await service.startReviewRun({
		documentId: "doc_same",
		pipelineVersion: "v1",
	});

	assert.equal(second.status, 202);
	assert.equal(second.body.id, first.body.id);
	assert.equal(second.body.idempotency_key, first.body.idempotency_key);
	assert.equal(service.reviewRuns().length, 1);
	assert.equal(queue.jobs().length, 1);
});

test("starts for the same document with different pipeline versions keep distinct runs", async () => {
	const { service, queue } = createService();

	const first = await service.startReviewRun({
		documentId: "doc_versions",
		pipelineVersion: "v1",
	});
	const second = await service.startReviewRun({
		documentId: "doc_versions",
		pipelineVersion: "v2",
	});
	const firstAgain = await service.startReviewRun({
		documentId: "doc_versions",
		pipelineVersion: "v1",
	});

	assert.notEqual(second.body.id, first.body.id);
	assert.equal(firstAgain.body.id, first.body.id);
	assert.equal(firstAgain.body.pipeline_version, "v1");
	assert.equal(service.reviewRuns().length, 2);
	assert.equal(queue.jobs().length, 2);
});

test("pipeline versions that normalize to the same slug still keep distinct runs", async () => {
	const { service, queue } = createService();

	await service.startReviewRun({
		documentId: "doc_collision",
		pipelineVersion: "v1",
	});
	const v2 = await service.startReviewRun({
		documentId: "doc_collision",
		pipelineVersion: "v2",
	});
	const v2Bang = await service.startReviewRun({
		documentId: "doc_collision",
		pipelineVersion: "v2!",
	});
	const v2Again = await service.startReviewRun({
		documentId: "doc_collision",
		pipelineVersion: "v2",
	});

	assert.notEqual(v2.body.id, v2Bang.body.id);
	assert.equal(v2Again.body.id, v2.body.id);
	assert.equal(v2Again.body.pipeline_version, "v2");
	assert.equal(service.reviewRuns().length, 3);
	assert.equal(queue.jobs().length, 3);
});

test("run ids are globally unique across document ids and pipeline attempts", async () => {
	const { service } = createService();

	const existing = await service.startReviewRun({
		documentId: "doc_collision_2",
		pipelineVersion: "v1",
	});
	await service.startReviewRun({
		documentId: "doc_collision",
		pipelineVersion: "v1",
	});
	const secondPipeline = await service.startReviewRun({
		documentId: "doc_collision",
		pipelineVersion: "v2",
	});
	const existingAgain = await service.startReviewRun({
		documentId: "doc_collision_2",
		pipelineVersion: "v1",
	});

	assert.notEqual(secondPipeline.body.id, existing.body.id);
	assert.equal(existingAgain.body.id, existing.body.id);
	assert.equal(existingAgain.body.thesis_document_id, "doc_collision_2");
	assert.equal(existingAgain.body.pipeline_version, "v1");
});

test("review run status transitions are validated and audited", async () => {
	const { service } = createService();
	const started = await service.startReviewRun({
		documentId: "doc_flow",
		pipelineVersion: "v1",
	});

	const extracting = service.transitionReviewRun(started.body.id, "extracting");
	const segmenting = service.transitionReviewRun(started.body.id, "segmenting");

	assert.equal(extracting.body.status, "extracting");
	assert.equal(segmenting.body.status, "segmenting");
	assert.deepEqual(
		service.auditEvents().map((event) => event.event_type),
		[
			"review_run.created",
			"review_run.job_enqueued",
			"review_run.status_changed",
			"review_run.status_changed",
		],
	);
	assert.throws(
		() => service.transitionReviewRun(started.body.id, "queued"),
		/Invalid review-run status transition/,
	);
});

test("review run can be cancelled before terminal states and cancellation is audited", async () => {
	const { service } = createService();
	const started = await service.startReviewRun({
		documentId: "doc_cancel",
		pipelineVersion: "v1",
	});

	const cancelled = service.cancelReviewRun(
		started.body.id,
		"reviewer requested cancellation",
	);

	assert.equal(cancelled.body.status, "cancelled");
	assert.equal(cancelled.body.error_summary, "reviewer requested cancellation");
	assert.equal(service.getReviewRun(started.body.id).body.status, "cancelled");
	assert.ok(
		service
			.auditEvents()
			.some((event) => event.event_type === "review_run.cancelled"),
	);
});

test("failed jobs set failed status and preserve support-ready error summary", async () => {
	const { service } = createService();
	const started = await service.startReviewRun({
		documentId: "doc_fail",
		pipelineVersion: "v1",
	});

	const failed = service.markJobFailed(started.body.id, {
		stage: "extract",
		message: "PDF parser timed out",
	});

	assert.equal(failed.body.status, "failed");
	assert.equal(
		failed.body.error_summary,
		"extract failed: PDF parser timed out",
	);
	assert.ok(failed.body.failed_at);
	assert.ok(
		service
			.auditEvents()
			.some((event) => event.event_type === "review_run.failed"),
	);
});

test("failed jobs cannot mutate completed or cancelled terminal runs", async () => {
	const { service } = createService();
	const completed = await service.startReviewRun({
		documentId: "doc_completed",
		pipelineVersion: "v1",
	});
	service.transitionReviewRun(completed.body.id, "extracting");
	service.transitionReviewRun(completed.body.id, "segmenting");
	service.transitionReviewRun(completed.body.id, "validating");
	service.transitionReviewRun(completed.body.id, "reporting");
	service.transitionReviewRun(completed.body.id, "completed");

	assert.throws(
		() =>
			service.markJobFailed(completed.body.id, {
				stage: "extract",
				message: "late failure",
			}),
		/Invalid review-run status transition/,
	);

	const cancelled = await service.startReviewRun({
		documentId: "doc_cancelled_terminal",
		pipelineVersion: "v1",
	});
	service.cancelReviewRun(
		cancelled.body.id,
		"cancelled before worker finished",
	);
	assert.throws(
		() =>
			service.markJobFailed(cancelled.body.id, {
				stage: "extract",
				message: "late failure",
			}),
		/Invalid review-run status transition/,
	);
});
