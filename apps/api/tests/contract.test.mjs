import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handleApiRequest, listApiRoutes } from "../src/api-contract.mjs";
import {
	_resetLiveReviewPipelineForTests,
	getLivePipeline,
} from "../src/live-review-pipeline.mjs";
import { processThesisDocumentUpload } from "../src/thesis-documents/upload-service.mjs";
import { createAuthenticatedSession } from "./support/reviewer-session-fixture.mjs";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

// reviewer-authentication PR3a: every route below (except the two public
// auth routes) now sits behind the deny-by-default `checkSession` gate
// (design.md D6). Reset the schema to head and mint one real reviewer
// session once for this whole file, mirroring the real-Postgres pattern
// every other integration test file already uses.
let authHeaders;

before(async () => {
	const { default: pg } = await import("pg");
	const migrate = await import("../src/db/migrate.mjs");
	const client = new pg.Client({
		connectionString: databaseUrl,
		connectionTimeoutMillis: 2000,
	});
	await client.connect();
	await migrate.migrateDown({ client }).catch(() => {});
	await migrate.migrateUp({ client });
	await client.end();

	process.env.DATABASE_URL = databaseUrl;
	const session = await createAuthenticatedSession({ connectionString: databaseUrl });
	authHeaders = session.headers;
});

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
		"POST /api/v1/auth/sessions",
		"DELETE /api/v1/auth/sessions/current",
	]);
});

// reviewer-authentication PR3a: with `DATABASE_URL` unset, `checkSession`
// (via `resolveReviewerRepository()`) cannot verify ANY session, so the
// deny-by-default gate now answers `503` for every protected route before
// ever reaching the board-repository-unavailable branch this test used to
// exercise — the previous "graceful 200 empty board" behavior for this
// specific unauthenticated case no longer applies once auth itself requires
// a reachable database.
test("GET /api/v1/review-board/cards returns 503 when no database is configured, because the session gate itself requires one", async () => {
	const originalDatabaseUrl = process.env.DATABASE_URL;
	delete process.env.DATABASE_URL;
	_resetLiveReviewPipelineForTests();
	try {
		const response = await handleApiRequest({
			method: "GET",
			path: "/api/v1/review-board/cards",
			headers: authHeaders,
		});

		expectStandardError(response, 503);
		assert.equal(response.body.error, "service_unavailable");
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
		headers: authHeaders,
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
		headers: authHeaders,
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
		headers: authHeaders,
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
		headers: authHeaders,
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
		headers: authHeaders,
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
		headers: authHeaders,
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
		headers: authHeaders,
	});
	assert.equal(runResponse.status, 202);
	const runId = runResponse.body.id;

	const response = await handleApiRequest({
		method: "GET",
		path: `/api/v1/review-runs/${runId}/report-artifacts`,
		headers: authHeaders,
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
		headers: authHeaders,
	});

	expectStandardError(response, 422);
	assert.equal(response.body.error, "validation_error");
	assert.ok(Array.isArray(response.body.details.issues));
});

// reviewer-authentication PR3a (design.md D6/Scope Guard, Unit 3a RED case
// 1): every route `listApiRoutes()` reports, except the two public auth
// routes, must 401 with no `Authorization` header — proven directly against
// every route, not by convention — and must never read/create/modify
// anything (no side effect fires) before the session gate rejects it.
test("session gate: every route except the two auth routes returns 401 with no Authorization header, and no side effect fires", async () => {
	const protectedRoutes = listApiRoutes().filter(
		(route) =>
			!(route.method === "POST" && route.path === "/api/v1/auth/sessions") &&
			!(
				route.method === "DELETE" &&
				route.path === "/api/v1/auth/sessions/current"
			),
	);
	assert.ok(protectedRoutes.length > 0, "the sweep must cover at least one route");

	const boardBefore =
		(await getLivePipeline()?.repository.listReviewBoardCards()) ?? [];

	for (const route of protectedRoutes) {
		const concretePath = route.path
			.replace("{document_id}", "sweep_fixture_doc")
			.replace("{run_id}", "sweep_fixture_run")
			.replace("{card_id}", "sweep_fixture_card");
		const response = await handleApiRequest({
			method: route.method,
			path: concretePath,
			body: { reviewerName: "Should Never Persist", priority: "urgent" },
		});
		expectStandardError(response, 401);
		assert.equal(
			response.body.error,
			"unauthorized",
			`${route.method} ${route.path} must 401 unauthorized with no session`,
		);
	}

	const boardAfter =
		(await getLivePipeline()?.repository.listReviewBoardCards()) ?? [];
	assert.deepEqual(
		boardAfter,
		boardBefore,
		"no unauthenticated request in the sweep above may have created/modified a review-board card",
	);
});

// reviewer-authentication PR3a (TRIANGULATE): a genuinely unknown route must
// still 404, never leaking a 401 that would confirm the path is registered —
// the session gate is skipped entirely for paths that match no `ROUTES`
// entry, and it must not accidentally bypass the existing 404 branch either.
test("session gate: a genuinely unknown route still 404s with no Authorization header, never 401", async () => {
	const response = await handleApiRequest({
		method: "GET",
		path: "/api/v1/genuinely-unknown-route",
	});

	expectStandardError(response, 404);
	assert.equal(response.body.error, "not_found");
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
