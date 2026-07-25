import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
		async getObject(key) {
			const object = objects.get(key);
			if (!object) throw new Error(`Object not found for key: ${key}`);
			return {
				key,
				content: object.content,
				contentType: object.contentType ?? null,
				metadata: object.metadata ?? {},
			};
		},
		listKeys() {
			return [...objects.keys()].sort();
		},
		buildKeyForTest({ sha256, filename }) {
			return buildStorageKey({ keyPrefix, sha256, filename });
		},
	};
}

/**
 * Filesystem-backed object storage (design decision #11): real bytes on
 * disk under `baseDir`, so content survives across requests within the same
 * running API process — required for the live review pipeline to read back
 * an uploaded document's bytes when a review run is triggered in a
 * follow-up request. Same interface as `createMemoryObjectStorage` (`put
 * Object`/`getObject`/`buildKeyForTest`), so callers never need to branch on
 * which adapter is active.
 */
export function createFilesystemObjectStorage({
	baseDir,
	keyPrefix = "thesis-documents",
} = {}) {
	const rootDir = baseDir ?? path.join(tmpdir(), "pg1-thesis-storage");

	function resolvePath(key) {
		return path.join(rootDir, key);
	}

	return {
		provider: "filesystem-local",
		keyPrefix,
		async putObject({ key, content, contentType, metadata = {} }) {
			const bytes = Buffer.isBuffer(content)
				? content
				: Buffer.from(content ?? "");
			const filePath = resolvePath(key);
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, bytes);
			await writeFile(
				`${filePath}.meta.json`,
				JSON.stringify({ contentType: contentType ?? null, metadata }),
				"utf8",
			);
			return { key, provider: "filesystem-local", size: bytes.byteLength };
		},
		async getObject(key) {
			const filePath = resolvePath(key);
			const [content, metaRaw] = await Promise.all([
				readFile(filePath),
				readFile(`${filePath}.meta.json`, "utf8").catch(() => "{}"),
			]);
			const meta = JSON.parse(metaRaw || "{}");
			return {
				key,
				content,
				contentType: meta.contentType ?? null,
				metadata: meta.metadata ?? {},
			};
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
