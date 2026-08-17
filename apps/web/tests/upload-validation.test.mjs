import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSelectedFiles } from "../src/app/upload/upload-validation.ts";

test("valid PDF selection passes validation", () => {
	const result = validateSelectedFiles([
		{ type: "application/pdf", size: 20 * 1024 * 1024 },
	]);
	assert.deepEqual(result, { ok: true });
});

test("valid DOCX selection passes validation", () => {
	const result = validateSelectedFiles([
		{
			type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			size: 1024,
		},
	]);
	assert.deepEqual(result, { ok: true });
});

test("unsupported file type is rejected", () => {
	const result = validateSelectedFiles([{ type: "text/plain", size: 1024 }]);
	assert.equal(result.ok, false);
	assert.equal(result.code, "unsupported_type");
});

test("files larger than 20 MB are rejected", () => {
	const result = validateSelectedFiles([
		{ type: "application/pdf", size: 20 * 1024 * 1024 + 1 },
	]);
	assert.equal(result.ok, false);
	assert.equal(result.code, "file_size");
	assert.match(result.message, /20 MB/);
});

test("zero files is rejected", () => {
	const result = validateSelectedFiles([]);
	assert.equal(result.ok, false);
	assert.equal(result.code, "file_count");
});

test("multiple files is rejected", () => {
	const result = validateSelectedFiles([
		{ type: "application/pdf", size: 1024 },
		{ type: "application/pdf", size: 1024 },
	]);
	assert.equal(result.ok, false);
	assert.equal(result.code, "file_count");
});
