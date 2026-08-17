import { createHash } from "node:crypto";

const DEFAULT_DIMENSIONS = 1536;

export function createDeterministicEmbeddingProvider({
	model = "pg1-deterministic-local-embedding-1536",
	dimensions = DEFAULT_DIMENSIONS,
} = {}) {
	return {
		model,
		async embed(text) {
			const vector = Array(dimensions).fill(0);
			const tokens = String(text ?? "")
				.toLowerCase()
				.normalize("NFKD")
				.replace(/[\u0300-\u036f]/g, "")
				.match(/[a-z0-9]+/g) ?? ["empty"];
			for (const token of tokens) {
				const digest = createHash("sha256").update(token).digest();
				const index = digest.readUInt16BE(0) % dimensions;
				vector[index] += 1;
			}
			const magnitude = Math.hypot(...vector) || 1;
			return vector.map((value) => value / magnitude);
		},
	};
}
