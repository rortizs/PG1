import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewProgressView } from "../src/app/review-board/review-progress-view.ts";

const activeCase = (status, stage, percent) => [
	status,
	{
		status,
		stage,
		percent,
		state: "active",
		isProjected: true,
		nextAction: null,
	},
];

test("review lifecycle statuses map to deterministic projected stages", () => {
	for (const [status, expected] of [
		activeCase("queued", "Uploading", 10),
		activeCase("extracting", "Extracting text", 30),
		activeCase("validating", "Running rules", 60),
		activeCase("rag_reviewing", "Running review", 75),
		activeCase("reporting", "Generating report", 90),
	]) {
		assert.deepEqual(buildReviewProgressView(status), expected);
	}
});

test("terminal statuses expose completed or recovery states at 100 percent", () => {
	assert.deepEqual(buildReviewProgressView("completed"), {
		status: "completed",
		stage: "Completed",
		percent: 100,
		state: "completed",
		isProjected: true,
		nextAction: null,
	});
	assert.deepEqual(buildReviewProgressView("failed"), {
		status: "failed",
		stage: "Failed",
		percent: 100,
		state: "failed",
		isProjected: true,
		nextAction: "Review the error and upload the thesis again when ready.",
	});
	assert.deepEqual(buildReviewProgressView("cancelled"), {
		status: "cancelled",
		stage: "Cancelled",
		percent: 100,
		state: "cancelled",
		isProjected: true,
		nextAction: "Start a new review run when the thesis is ready.",
	});
});

test("unknown statuses stay visible without claiming real-time progress", () => {
	assert.deepEqual(buildReviewProgressView("paused"), {
		status: "paused",
		stage: "Review status unavailable",
		percent: 0,
		state: "unknown",
		isProjected: true,
		nextAction: "Refresh the review run before making a decision.",
	});
});
