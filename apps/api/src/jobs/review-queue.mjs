export function createMemoryReviewQueue() {
	const queuedJobs = new Map();

	return {
		async add(name, payload, options = {}) {
			const idempotencyKey = options.idempotencyKey;
			if (idempotencyKey && queuedJobs.has(idempotencyKey)) {
				return queuedJobs.get(idempotencyKey);
			}
			const job = {
				id: idempotencyKey ?? `${name}:${queuedJobs.size + 1}`,
				name,
				payload,
				idempotencyKey,
				attempts: options.attempts ?? 1,
			};
			queuedJobs.set(job.id, job);
			return job;
		},
		jobs() {
			return [...queuedJobs.values()];
		},
	};
}
