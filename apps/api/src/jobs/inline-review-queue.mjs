/**
 * Inline queue adapter: same `add()` seam as `createMemoryReviewQueue`
 * (same call signature, same returned job shape), but the given `processor`
 * runs synchronously — awaited inline, before `add()` resolves — instead of
 * only being recorded for a worker to pick up later. This is the temporary
 * synchronous shortcut called out in `design.md`; a real BullMQ-backed queue
 * can swap in later with no caller change, since the seam is identical.
 */
export function createInlineReviewQueue({ processor }) {
	if (typeof processor !== "function") {
		throw new TypeError(
			"createInlineReviewQueue requires a `processor` function.",
		);
	}

	const processedJobs = new Map();

	return {
		async add(name, payload, options = {}) {
			const idempotencyKey = options.idempotencyKey;
			if (idempotencyKey && processedJobs.has(idempotencyKey)) {
				return processedJobs.get(idempotencyKey);
			}

			const job = {
				id: idempotencyKey ?? `${name}:${processedJobs.size + 1}`,
				name,
				payload,
				idempotencyKey,
				attempts: options.attempts ?? 1,
			};

			await processor(payload);

			processedJobs.set(job.id, job);
			return job;
		},
		jobs() {
			return [...processedJobs.values()];
		},
	};
}
