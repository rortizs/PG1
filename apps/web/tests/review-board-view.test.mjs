import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildReviewBoardColumns,
	mapReviewRunToBoardState,
} from "../src/app/review-board/review-board-view.ts";

const card = (id, priority, status, extra = {}) => ({
	id,
	priority,
	status,
	studentName: id,
	thesisTitle: `${id} thesis`,
	...extra,
});

test("running lifecycle statuses map to In Review", () => {
	for (const status of [
		"queued",
		"extracting",
		"segmenting",
		"validating",
		"rag_reviewing",
		"reporting",
	]) {
		assert.equal(mapReviewRunToBoardState({ status }), "In Review");
	}
});

test("completed runs map to Reviewed unless human approved", () => {
	assert.equal(mapReviewRunToBoardState({ status: "completed" }), "Reviewed");
	assert.equal(
		mapReviewRunToBoardState({
			status: "completed",
			approvalState: "approved",
		}),
		"Approved",
	);
});

test("failed and cancelled cards remain visible with their terminal status", () => {
	const inReviewCards = buildReviewBoardColumns([
		card("failed-run", "Urgent", "failed"),
		card("cancelled-run", "Normal", "cancelled"),
	]).find((column) => column.state === "In Review")?.cards;

	assert.deepEqual(
		inReviewCards?.map(({ id, attention }) => [id, attention]),
		[
			["failed-run", "failed"],
			["cancelled-run", "cancelled"],
		],
	);
});

test("board columns contain each card once and sort urgent work first", () => {
	const columns = buildReviewBoardColumns([
		card("normal-pending", "Normal", null),
		card("urgent-pending", "Urgent", null),
		card("reviewed", "Low", "completed"),
	]);

	assert.deepEqual(
		columns.map(({ state, cards }) => [state, cards.map(({ id }) => id)]),
		[
			["Pending", ["urgent-pending", "normal-pending"]],
			["In Review", []],
			["Reviewed", ["reviewed"]],
			["Approved", []],
		],
	);
});
