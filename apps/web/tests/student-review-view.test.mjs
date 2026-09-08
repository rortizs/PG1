import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStudentReviewViewModel } from "../src/app/review-board/student-review-view.ts";

function card(overrides = {}) {
	return {
		id: "student-1",
		student_name: "Ada Lovelace",
		thesis_title: "Analytical Engines in Education",
		priority: "normal",
		board_state: "pending",
		review_run_status: null,
		reviewer_label: null,
		report_ready: false,
		current_review_run_id: null,
		attention_text: null,
		...overrides,
	};
}

function run(overrides = {}) {
	return {
		id: "run_1",
		type: "review_run",
		thesis_document_id: "doc_1",
		status: "queued",
		progress_stage: "queued",
		created_at: null,
		started_at: null,
		completed_at: null,
		failed_at: null,
		error_summary: null,
		summary: { pages: 0, sections: 0, findings: 0, reports: 0 },
		llm_provider_name: null,
		llm_model_id: null,
		...overrides,
	};
}

test("buildStudentReviewViewModel shows loading state before the cards have loaded", () => {
	const view = buildStudentReviewViewModel({
		studentId: "student-1",
		cards: null,
		loadError: null,
		run: null,
		reportArtifacts: null,
	});
	assert.deepEqual(view, { kind: "loading" });
});

test("buildStudentReviewViewModel surfaces a load error", () => {
	const view = buildStudentReviewViewModel({
		studentId: "student-1",
		cards: null,
		loadError: "Unable to load review board cards.",
		run: null,
		reportArtifacts: null,
	});
	assert.deepEqual(view, {
		kind: "error",
		message: "Unable to load review board cards.",
	});
});

test("buildStudentReviewViewModel shows not_found when the studentId does not match any card", () => {
	const view = buildStudentReviewViewModel({
		studentId: "unknown-student",
		cards: [card({ id: "student-1" })],
		loadError: null,
		run: null,
		reportArtifacts: null,
	});
	assert.deepEqual(view, { kind: "not_found", studentId: "unknown-student" });
});

test("buildStudentReviewViewModel shows a found student with no review run yet", () => {
	const view = buildStudentReviewViewModel({
		studentId: "student-1",
		cards: [
			card({
				id: "student-1",
				review_run_status: null,
				current_review_run_id: null,
			}),
		],
		loadError: null,
		run: null,
		reportArtifacts: null,
	});
	assert.deepEqual(view, {
		kind: "found",
		studentName: "Ada Lovelace",
		thesisTitle: "Analytical Engines in Education",
		boardState: "pending",
		priority: "Normal",
		reviewerName: "Unassigned",
		status: null,
		reportArtifact: null,
	});
});

test("buildStudentReviewViewModel shows a found student with an in-progress review run", () => {
	const view = buildStudentReviewViewModel({
		studentId: "student-1",
		cards: [
			card({
				id: "student-1",
				board_state: "in_review",
				priority: "urgent",
				review_run_status: "rag_reviewing",
				reviewer_label: "Dr. Rivera",
				current_review_run_id: "run_1",
			}),
		],
		loadError: null,
		run: run({ status: "rag_reviewing", progress_stage: "rag_reviewing" }),
		reportArtifacts: [],
	});
	assert.deepEqual(view, {
		kind: "found",
		studentName: "Ada Lovelace",
		thesisTitle: "Analytical Engines in Education",
		boardState: "in_review",
		priority: "Urgent",
		reviewerName: "Dr. Rivera",
		status: "rag_reviewing",
		reportArtifact: null,
	});
});

test("buildStudentReviewViewModel shows a found student with a completed run and a downloadable report", () => {
	const artifact = {
		id: "run_1-markdown-report",
		kind: "markdown",
		filename: "review-run-run_1-report.md",
		content_type: "text/markdown; charset=utf-8",
		content: "# Thesis Review Report\n",
	};
	const view = buildStudentReviewViewModel({
		studentId: "student-1",
		cards: [
			card({
				id: "student-1",
				board_state: "reviewed",
				priority: "low",
				review_run_status: "completed",
				reviewer_label: "Prof. Chen",
				report_ready: true,
				current_review_run_id: "run_1",
			}),
		],
		loadError: null,
		run: run({ status: "completed", progress_stage: "completed" }),
		reportArtifacts: [artifact],
	});
	assert.deepEqual(view, {
		kind: "found",
		studentName: "Ada Lovelace",
		thesisTitle: "Analytical Engines in Education",
		boardState: "reviewed",
		priority: "Low",
		reviewerName: "Prof. Chen",
		status: "completed",
		reportArtifact: artifact,
	});
});

test("buildStudentReviewViewModel shows a found student with a completed run but no report artifact yet", () => {
	const view = buildStudentReviewViewModel({
		studentId: "student-1",
		cards: [
			card({
				id: "student-1",
				board_state: "reviewed",
				review_run_status: "completed",
				current_review_run_id: "run_1",
			}),
		],
		loadError: null,
		run: run({ status: "completed", progress_stage: "completed" }),
		reportArtifacts: [],
	});
	assert.deepEqual(view, {
		kind: "found",
		studentName: "Ada Lovelace",
		thesisTitle: "Analytical Engines in Education",
		boardState: "reviewed",
		priority: "Normal",
		reviewerName: "Unassigned",
		status: "completed",
		reportArtifact: null,
	});
});
