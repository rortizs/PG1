export function createMemoryObjectStorage({
	keyPrefix = "thesis-documents",
} = {}) {
	const objects = new Map();
	return {
		provider: "memory-local",
		keyPrefix,
		async putObject({ key, content, contentType, metadata = {} }) {
			const bytes = Buffer.isBuffer(content)
				? content
				: Buffer.from(content ?? "");
			objects.set(key, {
				key,
				content: bytes,
				contentType,
				metadata,
				size: bytes.byteLength,
			});
			return { key, provider: "memory-local", size: bytes.byteLength };
		},
		get(key) {
			return objects.get(key);
		},
		listKeys() {
			return [...objects.keys()].sort();
		},
		buildKeyForTest({ sha256, filename }) {
			return buildStorageKey({ keyPrefix, sha256, filename });
		},
	};
}

export function buildStorageKey({
	keyPrefix = "thesis-documents",
	sha256,
	filename,
}) {
	return `${trimSlashes(keyPrefix)}/${sha256}/${slugFileName(filename)}`;
}

function trimSlashes(value) {
	return String(value || "thesis-documents").replace(/^\/+|\/+$/g, "");
}

function slugFileName(filename) {
	const slug = String(filename || "document")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9.]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "document";
}
