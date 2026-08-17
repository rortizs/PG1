import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

test("review board and student review routes are registered with standalone page components", async () => {
	const routesSource = await readFile(
		new URL("../src/app/app.routes.ts", import.meta.url),
		"utf8",
	);

	assert.match(routesSource, /review-board/);
	assert.match(routesSource, /students\/:studentId\/review/);
	assert.match(routesSource, /ReviewBoardPage/);
	assert.match(routesSource, /StudentReviewPage/);
});

test("review board page uses API board data first and labels demo fallback honestly", async () => {
	const source = await readFile(
		new URL("../src/app/review-board/review-board-page.ts", import.meta.url),
		"utf8",
	);

	assert.match(source, /REVIEW_BOARD_CARDS_API_PATH/);
	assert.match(source, /mapReviewBoardApiItemsToCards/);
	assert.match(source, /buildReviewBoardColumns/);
	assert.match(source, /DEMO_FALLBACK_REVIEW_BOARD_CARDS/);
	assert.match(source, /Demo fallback board data/);
	assert.match(source, /Rules \+ CAG review/);
	assert.match(source, /RAG-retrieved normative context/);
});

test("student review page reuses upload, progress, and Markdown report helpers and truthfully claims RAG retrieval", async () => {
	const source = await readFile(
		new URL("../src/app/review-board/student-review-page.ts", import.meta.url),
		"utf8",
	);

	assert.match(source, /validateSelectedFiles/);
	assert.match(source, /buildReviewProgressView/);
	assert.match(source, /buildMarkdownReportDownload/);
	assert.match(source, /Download Markdown Report/);
	assert.match(source, /Rules \+ CAG review/);
	assert.match(source, /RAG-retrieved normative context/);
});
