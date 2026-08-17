import { test } from "node:test";
import assert from "node:assert/strict";

import {
	REVIEW_BOARD_CARDS_API_PATH,
	mapReviewBoardApiItemsToCards,
	selectReviewBoardDisplayCards,
} from "../src/app/review-board/review-board-api.ts";

test("review board API seam maps durable cards into the existing board view model", () => {
	assert.equal(REVIEW_BOARD_CARDS_API_PATH, "/api/v1/review-board/cards");

	const [card] = mapReviewBoardApiItemsToCards([
		{
			id: "workflow-card-1",
			student_name: "Ada Lovelace",
			thesis_title: "Analytical Engines in Education",
			priority: "urgent",
			board_state: "approved",
			review_run_status: "completed",
			reviewer_label: "Dr. Rivera",
			report_ready: true,
		},
	]);

	assert.deepEqual(card, {
		id: "workflow-card-1",
		studentName: "Ada Lovelace",
		thesisTitle: "Analytical Engines in Education",
		priority: "Urgent",
		status: "completed",
		approvalState: "approved",
		reviewerName: "Dr. Rivera",
		reportReady: true,
	});
});

test("review board display prefers API data and uses demo cards only as fallback", () => {
	const demoFallbackCards = [
		{
			id: "demo-card",
			studentName: "Demo Student",
			thesisTitle: "Demo Thesis",
			priority: "Normal",
			status: null,
			reportReady: false,
		},
	];

	assert.deepEqual(
		selectReviewBoardDisplayCards({
			apiCards: [],
			demoFallbackCards,
		}),
		{ source: "api", cards: [] },
	);
	assert.deepEqual(
		selectReviewBoardDisplayCards({
			apiCards: null,
			demoFallbackCards,
		}),
		{ source: "demo_fallback", cards: demoFallbackCards },
	);
});
