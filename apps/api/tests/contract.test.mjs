import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handleApiRequest, listApiRoutes } from "../src/api-contract.mjs";
import { _resetLiveReviewPipelineForTests } from "../src/live-review-pipeline.mjs";
import { processThesisDocumentUpload } from "../src/thesis-documents/upload-service.mjs";

const STANDARD_ERROR_KEYS = [
	"error",
	"message",
	"details",
	"request_id",
	"timestamp",
];

function expectStandardError(response, status) {
	assert.equal(response.status, status);
	assert.deepEqual(
		Object.keys(response.body).sort(),
		STANDARD_ERROR_KEYS.toSorted(),
	);
	assert.equal(typeof response.body.error, "string");
	assert.equal(typeof response.body.message, "string");
	assert.equal(typeof response.body.request_id, "string");
	assert.match(response.body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
}

function expectPaginatedList(body) {
	assert.ok(Array.isArray(body.items));
	assert.equal(typeof body.page, "number");
	assert.equal(typeof body.page_size, "number");
	assert.equal(typeof body.total, "number");
	assert.equal(typeof body.filters, "object");
}

test("API contract exposes the required versioned resource routes", () => {
	const routes = listApiRoutes().map(
		(route) => `${route.method} ${route.path}`,
	);

	assert.deepEqual(routes, [
		"POST /api/v1/thesis-documents",
		"GET /api/v1/thesis-documents",
		"POST /api/v1/thesis-documents/{document_id}/review-runs",
		"GET /api/v1/review-runs/{run_id}",
		"GET /api/v1/review-runs/{run_id}/findings",
		"GET /api/v1/review-runs/{run_id}/report-artifacts",
		"GET /api/v1/review-board/cards",
		"PATCH /api/v1/review-board/cards/{card_id}/priority",
		"POST /api/v1/review-board/cards/{card_id}/approval",
	]);
});

test("GET /api/v1/review-board/cards returns an explicit empty board when no live repository is configured", async () => {
	const originalDatabaseUrl = process.env.DATABASE_URL;
	delete process.env.DATABASE_URL;
	_resetLiveReviewPipelineForTests();
	try {
		const response = await handleApiRequest({
			method: "GET",
			path: "/api/v1/review-board/cards",
		});

		assert.equal(response.status, 200);
		expectPaginatedList(response.body);
		assert.deepEqual(response.body.items, []);
	} finally {
		if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = originalDatabaseUrl;
		_resetLiveReviewPipelineForTests();
	}
});

test("POST /api/v1/thesis-documents returns a contract-valid upload stub", async () => {
	const response = await handleApiRequest({
		method: "POST",
		path: "/api/v1/thesis-documents",
	});

	assert.equal(response.status, 201);
	assert.equal(response.body.type, "thesis_document");
	assert.equal(response.body.status, "upload_stub");
	assert.equal(response.body.review_eligible, false);
	assert.match(response.body.id, /^doc_/);
});

test("server-side upload validation rejects files larger than 20 MB before storage", async () => {
	let putObjectCalls = 0;
	const maxBytes = 20 * 1024 * 1024;
	const response = await processThesisDocumentUpload({
		files: [
			{
				filename: "too-large.pdf",
				contentType: "application/pdf",
				content: Buffer.alloc(maxBytes + 1),
				size: maxBytes + 1,
			},
		],
		storage: {
			keyPrefix: "test-thesis-documents",
			async putObject() {
				putObjectCalls += 1;
				throw new Error("oversized upload should not be stored");
			},
		},
	});

	expectStandardError(response, 422);
	assert.equal(response.body.error, "validation_error");
	assert.equal(response.body.details.review_run_created, false);
	assert.equal(putObjectCalls, 0);
});

test("server-side upload validation accepts a PDF exactly at the 20 MB boundary", async () => {
	let putObjectCalls = 0;
	const maxBytes = 20 * 1024 * 1024;
	const response = await processThesisDocumentUpload({
		files: [
			{
				filename: "boundary.pdf",
				contentType: "application/pdf",
				content: Buffer.alloc(maxBytes),
				size: maxBytes,
			},
		],
		storage: {
			keyPrefix: "test-thesis-documents",
			async putObject({ key }) {
				putObjectCalls += 1;
				return { key, provider: "memory" };
			},
		},
	});

	assert.equal(response.status, 201);
	assert.equal(response.body.file_size_bytes, maxBytes);
	assert.equal(putObjectCalls, 1);
});

test("GET /api/v1/thesis-documents returns a bounded paginated list with filters", async () => {
	const response = await handleApiRequest({
		method: "GET",
		path: "/api/v1/thesis-documents",
		query: { page: "2", page_size: "10", status: "uploaded" },
	});

	assert.equal(response.status, 200);
	expectPaginatedList(response.body);
	assert.equal(response.body.page, 2);
	assert.equal(response.body.page_size, 10);
	assert.deepEqual(response.body.filters, { status: "uploaded" });
});

test("POST /api/v1/thesis-documents/{document_id}/review-runs returns lifecycle-backed 202 response", async () => {
	const response = await handleApiRequest({
		method: "POST",
		path: "/api/v1/thesis-documents/doc_contract/review-runs",
		body: { pipelineVersion: "pipeline-contract" },
	});

	assert.equal(response.status, 202);
	assert.equal(response.body.type, "review_run");
	assert.equal(response.body.thesis_document_id, "doc_contract");
	assert.equal(response.body.status, "queued");
	assert.equal(response.body.progress_stage, "queued");
	assert.equal(
		response.body.idempotency_key,
		`review_run:${response.body.id}:extract:pipeline-contract`,
	);
	assert.match(response.body.status_url, /^\/api\/v1\/review-runs\/run_/);
});

test("GET /api/v1/review-runs/{run_id} returns a status contract stub", async () => {
	const response = await handleApiRequest({
		method: "GET",
		path: "/api/v1/review-runs/run_contract",
	});

	assert.equal(response.status, 200);
	assert.equal(response.body.id, "run_contract");
	assert.equal(response.body.status, "queued");
	assert.equal(response.body.progress_stage, "contract_stub");
	assert.ok(response.body.summary);
});

test("GET /api/v1/review-runs/{run_id}/findings returns bounded findings list with filters", async () => {
	const response = await handleApiRequest({
		method: "GET",
		path: "/api/v1/review-runs/run_contract/findings",
		query: { page: "1", page_size: "25", type: "apa", severity: "medium" },
	});

	assert.equal(response.status, 200);
	expectPaginatedList(response.body);
	assert.equal(response.body.review_run_id, "run_contract");
	assert.equal(response.body.page_size, 25);
	assert.deepEqual(response.body.filters, { type: "apa", severity: "medium" });
});

test("GET /api/v1/review-runs/{run_id}/report-artifacts returns pending for an unknown run", async () => {
	const response = await handleApiRequest({
		method: "GET",
		path: "/api/v1/review-runs/run_contract/report-artifacts",
	});

	assert.equal(response.status, 200);
	assert.equal(response.body.review_run_id, "run_contract");
	assert.deepEqual(response.body.items, []);
	assert.equal(response.body.status, "pending");
});

test("GET /api/v1/review-runs/{run_id}/report-artifacts returns a downloadable Markdown report for an existing run with no findings", async () => {
	const runResponse = await handleApiRequest({
		method: "POST",
		path: "/api/v1/thesis-documents/doc_report_contract/review-runs",
		body: { pipelineVersion: "pipeline-report-contract" },
	});
	assert.equal(runResponse.status, 202);
	const runId = runResponse.body.id;

	const response = await handleApiRequest({
		method: "GET",
		path: `/api/v1/review-runs/${runId}/report-artifacts`,
	});

	assert.equal(response.status, 200);
	assert.equal(response.body.review_run_id, runId);
	assert.equal(response.body.status, "available");
	assert.equal(response.body.items.length, 1);
	assert.deepEqual(
		Object.keys(response.body.items[0]).sort(),
		["content", "content_type", "filename", "id", "kind"].sort(),
	);
	const [artifact] = response.body.items;
	assert.equal(artifact.id, `${runId}-markdown-report`);
	assert.equal(artifact.kind, "markdown");
	assert.equal(artifact.filename, `review-run-${runId}-report.md`);
	assert.equal(artifact.content_type, "text/markdown; charset=utf-8");
	assert.match(artifact.content, /^# Thesis Review Report\n/);
	assert.match(artifact.content, /## Executive Summary/);
	assert.match(artifact.content, /## Overall Verdict \/ Readiness/);
	assert.match(artifact.content, /## Finding Counts by Severity/);
	assert.match(artifact.content, /## Detailed Findings/);
	assert.match(artifact.content, /## Evidence/);
	assert.match(artifact.content, /## Recommended Actions/);
	assert.match(
		artifact.content,
		/No findings were recorded for this review run\./,
	);
});

test("unsupported routes return the standard error shape", async () => {
	const response = await handleApiRequest({
		method: "GET",
		path: "/api/v1/unknown",
	});

	expectStandardError(response, 404);
	assert.equal(response.body.error, "not_found");
});

test("invalid pagination returns the standard error shape", async () => {
	const response = await handleApiRequest({
		method: "GET",
		path: "/api/v1/thesis-documents",
		query: { page: "0", page_size: "500" },
	});

	expectStandardError(response, 422);
	assert.equal(response.body.error, "validation_error");
	assert.ok(Array.isArray(response.body.details.issues));
});

test("API contract has NestJS-compatible controller and module seams", async () => {
	const files = await Promise.all([
		readFile(new URL("../src/app.module.ts", import.meta.url), "utf8"),
		readFile(
			new URL(
				"../src/thesis-documents/thesis-documents.controller.ts",
				import.meta.url,
			),
			"utf8",
		),
		readFile(
			new URL("../src/review-runs/review-runs.controller.ts", import.meta.url),
			"utf8",
		),
	]);

	assert.match(files[0], /Pg1ApiModule/);
	assert.match(files[1], /ThesisDocumentsController/);
	assert.match(files[2], /ReviewRunsController/);
});

test("OpenAPI baseline documents Work Unit 2 routes and standard error schema", async () => {
	const openapi = await readFile(
		new URL("../../../docs/api/openapi.yaml", import.meta.url),
		"utf8",
	);

	assert.match(openapi, /\/api\/v1\/thesis-documents:/);
	assert.match(
		openapi,
		/\/api\/v1\/thesis-documents\/\{document_id\}\/review-runs:/,
	);
	assert.match(openapi, /\/api\/v1\/review-runs\/\{run_id\}\/findings:/);
	assert.match(
		openapi,
		/\/api\/v1\/review-runs\/\{run_id\}\/report-artifacts:/,
	);
	assert.match(openapi, /request_id:/);
	assert.match(openapi, /timestamp:/);
});

test("OpenAPI baseline does not duplicate the /api/v1 prefix between server and paths", async () => {
	const openapi = await readFile(
		new URL("../../../docs/api/openapi.yaml", import.meta.url),
		"utf8",
	);

	assert.match(openapi, /servers:\n {2}- url: \/\n/);
	assert.doesNotMatch(openapi, /url: \/api\/v1\npaths:\n {2}\/api\/v1\//);
});
