import { test } from "node:test";
import assert from "node:assert/strict";
import { createInlineReviewQueue } from "../src/jobs/inline-review-queue.mjs";

test("createInlineReviewQueue awaits the processor before add() resolves", async () => {
	const callOrder = [];
	const queue = createInlineReviewQueue({
		processor: async (payload) => {
			callOrder.push("processor-start");
			await Promise.resolve();
			callOrder.push("processor-end", payload.review_run_id);
		},
	});

	const job = await queue.add(
		"review.extract",
		{ review_run_id: "run_1" },
		{ idempotencyKey: "key_1", attempts: 3 },
	);
	callOrder.push("add-resolved");

	assert.deepEqual(callOrder, [
		"processor-start",
		"processor-end",
		"run_1",
		"add-resolved",
	]);
	assert.equal(job.id, "key_1");
	assert.equal(job.name, "review.extract");
	assert.equal(job.idempotencyKey, "key_1");
	assert.equal(job.attempts, 3);
	assert.deepEqual(job.payload, { review_run_id: "run_1" });
});

test("createInlineReviewQueue is idempotent by idempotencyKey — processor runs once", async () => {
	let processorCalls = 0;
	const queue = createInlineReviewQueue({
		processor: async () => {
			processorCalls += 1;
		},
	});

	const first = await queue.add(
		"review.extract",
		{ review_run_id: "run_2" },
		{ idempotencyKey: "key_2" },
	);
	const second = await queue.add(
		"review.extract",
		{ review_run_id: "run_2" },
		{ idempotencyKey: "key_2" },
	);

	assert.equal(processorCalls, 1);
	assert.equal(first.id, second.id);
	assert.equal(queue.jobs().length, 1);
});

test("createInlineReviewQueue requires a processor function", () => {
	assert.throws(() => createInlineReviewQueue({}), TypeError);
});

test("createInlineReviewQueue propagates processor errors to the caller of add()", async () => {
	const queue = createInlineReviewQueue({
		processor: async () => {
			throw new Error("boom");
		},
	});

	await assert.rejects(
		() => queue.add("review.extract", { review_run_id: "run_3" }),
		/boom/,
	);
});
