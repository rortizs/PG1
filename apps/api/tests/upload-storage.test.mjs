import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleApiRequest } from "../src/api-contract.mjs";
import { createMemoryObjectStorage } from "../src/storage/object-storage.mjs";
import { processThesisDocumentUpload } from "../src/thesis-documents/upload-service.mjs";

const DOCX_TYPE =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function file(overrides = {}) {
	const content = Buffer.from(overrides.content ?? "tesis content");
	return {
		filename: overrides.filename ?? "tesis.pdf",
		contentType: overrides.contentType ?? "application/pdf",
		content,
		size: overrides.size ?? content.byteLength,
	};
}

function expectStandardError(response, status, error) {
	assert.equal(response.status, status);
	assert.deepEqual(Object.keys(response.body).sort(), [
		"details",
		"error",
		"message",
		"request_id",
		"timestamp",
	]);
	assert.equal(response.body.error, error);
	assert.equal(typeof response.body.message, "string");
}

test("upload accepts one PDF and persists thesis_document-style metadata", async () => {
	const storage = createMemoryObjectStorage({ keyPrefix: "thesis-documents" });
	const content = Buffer.from("pdf thesis");
	const result = await processThesisDocumentUpload({
		files: [file({ filename: "capitulo-i.pdf", content })],
		uploaderUserId: 42,
		storage,
	});

	assert.equal(result.status, 201);
	assert.equal(result.body.type, "thesis_document");
	assert.equal(result.body.status, "uploaded");
	assert.equal(result.body.review_eligible, true);
	assert.equal(result.body.original_filename, "capitulo-i.pdf");
	assert.equal(result.body.content_type, "application/pdf");
	assert.equal(result.body.file_size_bytes, content.byteLength);
	assert.equal(result.body.uploaded_by_user_id, 42);
	assert.equal(
		result.body.sha256,
		createHash("sha256").update(content).digest("hex"),
	);
	assert.equal(
		result.body.storage_key,
		`thesis-documents/${result.body.sha256}/capitulo-i.pdf`,
	);
	assert.equal(
		storage.get(result.body.storage_key).content.toString(),
		"pdf thesis",
	);
});

test("upload accepts one DOCX and returns deterministic local/S3-compatible storage metadata", async () => {
	const storage = createMemoryObjectStorage({ keyPrefix: "manual-upload" });
	const content = Buffer.from("docx thesis");
	const result = await processThesisDocumentUpload({
		files: [
			file({ filename: "tesis final.docx", contentType: DOCX_TYPE, content }),
		],
		uploaderUserId: 7,
		storage,
	});

	const sha256 = createHash("sha256").update(content).digest("hex");
	assert.equal(result.status, 201);
	assert.equal(result.body.content_type, DOCX_TYPE);
	assert.equal(result.body.sha256, sha256);
	assert.equal(
		result.body.storage_key,
		`manual-upload/${sha256}/tesis-final.docx`,
	);
	assert.equal(result.body.storage_provider, "memory-local");
});

test("upload rejects empty thesis files and leaves storage untouched", async () => {
	const storage = createMemoryObjectStorage();
	const result = await processThesisDocumentUpload({
		files: [file({ filename: "empty.pdf", content: Buffer.alloc(0), size: 0 })],
		uploaderUserId: 1,
		storage,
	});

	expectStandardError(result, 422, "validation_error");
	assert.equal(result.body.details.issues[0].field, "files[0].content");
	assert.equal(result.body.details.review_run_created, false);
	assert.equal(storage.listKeys().length, 0);
});

test("upload rejects declared size mismatches and leaves storage untouched", async () => {
	const storage = createMemoryObjectStorage();
	const result = await processThesisDocumentUpload({
		files: [file({ filename: "mismatch.pdf", content: "abc", size: 999 })],
		uploaderUserId: 1,
		storage,
	});

	expectStandardError(result, 422, "validation_error");
	assert.equal(result.body.details.issues[0].field, "files[0].size");
	assert.equal(result.body.details.review_run_created, false);
	assert.equal(storage.listKeys().length, 0);
});

test("storage key builder falls back to document name when filename slug is empty", () => {
	const key = createMemoryObjectStorage().buildKeyForTest?.({
		sha256: "a".repeat(64),
		filename: "***",
	});

	assert.equal(key, `${"thesis-documents"}/${"a".repeat(64)}/document`);
});

test("upload rejects unsupported types with 415 and does not create review run", async () => {
	const storage = createMemoryObjectStorage();
	const result = await processThesisDocumentUpload({
		files: [file({ filename: "tesis.txt", contentType: "text/plain" })],
		uploaderUserId: 1,
		storage,
	});

	expectStandardError(result, 415, "unsupported_media_type");
	assert.equal(result.body.details.review_run_created, false);
	assert.equal(storage.listKeys().length, 0);
});

test("upload requires exactly one file and leaves storage untouched on rejection", async () => {
	const storage = createMemoryObjectStorage();
	const result = await processThesisDocumentUpload({
		files: [file({ filename: "a.pdf" }), file({ filename: "b.pdf" })],
		uploaderUserId: 1,
		storage,
	});

	expectStandardError(result, 422, "validation_error");
	assert.equal(result.body.details.issues[0].field, "files");
	assert.equal(result.body.details.review_run_created, false);
	assert.equal(storage.listKeys().length, 0);
});

test("API contract delegates upload validation when file input is provided", async () => {
	const response = await handleApiRequest({
		method: "POST",
		path: "/api/v1/thesis-documents",
		body: {
			files: [file({ filename: "api.pdf", content: "api content" })],
			uploaderUserId: 11,
		},
	});

	assert.equal(response.status, 201);
	assert.equal(response.body.status, "uploaded");
	assert.equal(response.body.original_filename, "api.pdf");
	assert.equal(response.body.review_eligible, true);
});
