import { createReviewRunLifecycleService } from "./review-runs/review-run-lifecycle.mjs";
import { processThesisDocumentUpload } from "./thesis-documents/upload-service.mjs";
import {
	getDocumentStorage,
	getLivePipeline,
	isKnownUploadedDocument,
	registerUploadedDocument,
} from "./live-review-pipeline.mjs";

// Stub/fallback lifecycle: preserved exactly as-is. Any review-run request
// for a document id that was never durably persisted (fabricated ids, or
// real uploads made while `DATABASE_URL` is unset) keeps using this
// in-memory-only, non-processing lifecycle — matching the pre-existing,
// contract-tested behavior.
const reviewRunLifecycle = createReviewRunLifecycleService();
const EMPTY_SUMMARY = { pages: 0, sections: 0, findings: 0, reports: 0 };

const ROUTES = [
	["POST", "/api/v1/thesis-documents"],
	["GET", "/api/v1/thesis-documents"],
	["POST", "/api/v1/thesis-documents/{document_id}/review-runs"],
	["GET", "/api/v1/review-runs/{run_id}"],
	["GET", "/api/v1/review-runs/{run_id}/findings"],
	["GET", "/api/v1/review-runs/{run_id}/report-artifacts"],
];

export function listApiRoutes() {
	return ROUTES.map(([method, path]) => ({ method, path }));
}

export async function handleApiRequest({ method, path, query = {}, body = {} }) {
	const normalizedMethod = method.toUpperCase();
	const pagination = parsePagination(query);
	if (pagination.error) return pagination.error;

	if (normalizedMethod === "POST" && path === "/api/v1/thesis-documents") {
		if (body.files !== undefined) {
			const result = await processThesisDocumentUpload({
				files: body.files,
				uploaderUserId: body.uploaderUserId ?? null,
				metadata: body.metadata ?? {},
				storage: getDocumentStorage(),
			});
			if (result.status === 201) {
				try {
					await registerUploadedDocument({
						documentId: result.body.id,
						sha256: result.body.sha256,
						storageKey: result.body.storage_key,
						contentType: result.body.content_type,
						filename: result.body.original_filename,
						fileSizeBytes: result.body.file_size_bytes,
						uploaderUserId: result.body.uploaded_by_user_id,
					});
				} catch (error) {
					return errorResponse(
						503,
						"service_unavailable",
						"The upload succeeded but could not be durably persisted.",
						{ reason: error.message },
					);
				}
			}
			return result;
		}
		return createdDocument();
	}

	if (normalizedMethod === "GET" && path === "/api/v1/thesis-documents") {
		return ok(
			paginated([], pagination.value, pickFilters(query, ["status", "search"])),
		);
	}

	const reviewRunCreate = path.match(
		/^\/api\/v1\/thesis-documents\/([^/]+)\/review-runs$/,
	);
	if (normalizedMethod === "POST" && reviewRunCreate) {
		const documentId = decodeURIComponent(reviewRunCreate[1]);
		const pipelineVersion = body.pipelineVersion ?? "pipeline-v1";
		try {
			const livePipeline = isKnownUploadedDocument(documentId)
				? getLivePipeline()
				: null;
			const lifecycle = livePipeline ? livePipeline.lifecycle : reviewRunLifecycle;
			return await lifecycle.startReviewRun({ documentId, pipelineVersion });
		} catch (error) {
			return errorResponse(
				503,
				"service_unavailable",
				"Unable to start the review run.",
				{ reason: error.message },
			);
		}
	}

	const reviewRun = path.match(/^\/api\/v1\/review-runs\/([^/]+)$/);
	if (normalizedMethod === "GET" && reviewRun) {
		return ok(await resolveReviewRunView(decodeURIComponent(reviewRun[1])));
	}

	const findings = path.match(/^\/api\/v1\/review-runs\/([^/]+)\/findings$/);
	if (normalizedMethod === "GET" && findings) {
		const runId = decodeURIComponent(findings[1]);
		const items = await resolveFindingsView(runId);
		return ok({
			review_run_id: runId,
			...paginated(items, pagination.value, pickFilters(query, ["type", "severity"])),
		});
	}

	const artifacts = path.match(
		/^\/api\/v1\/review-runs\/([^/]+)\/report-artifacts$/,
	);
	if (normalizedMethod === "GET" && artifacts) {
		return ok({
			review_run_id: decodeURIComponent(artifacts[1]),
			status: "pending",
			items: [],
		});
	}

	return errorResponse(404, "not_found", "API route was not found.", {
		method: normalizedMethod,
		path,
	});
}

function createdDocument() {
	return {
		status: 201,
		body: {
			id: "doc_contract_stub",
			type: "thesis_document",
			status: "upload_stub",
			review_eligible: false,
			links: { self: "/api/v1/thesis-documents/doc_contract_stub" },
		},
	};
}

/**
 * Real-vs-stub GET resolution: tries the live (Postgres-backed) lifecycle
 * first, then the in-memory stub lifecycle (which owns runs created for
 * fabricated/never-uploaded document ids), and only falls back to the
 * fully fabricated `reviewRunStatus()` stub when the run id is unknown to
 * both — exactly preserving `contract.test.mjs`'s "unknown run id" case.
 */
async function resolveReviewRunView(runId) {
	const livePipeline = getLivePipeline();
	if (livePipeline) {
		try {
			const result = livePipeline.lifecycle.getReviewRun(runId);
			return withRealSummary(result.body, livePipeline, runId);
		} catch {
			// Not a live-pipeline run — fall through.
		}
	}
	try {
		const result = reviewRunLifecycle.getReviewRun(runId);
		return { ...result.body, summary: { ...EMPTY_SUMMARY } };
	} catch {
		// Not a stub-lifecycle run either — fall through to the legacy stub.
	}
	return reviewRunStatus(runId);
}

async function withRealSummary(run, livePipeline, runId) {
	let findings = 0;
	if (run.status === "completed") {
		try {
			const reviewRunDbId = livePipeline.getReviewRunDbId(runId);
			if (reviewRunDbId) {
				findings = (
					await livePipeline.repository.listFindingsForReviewRun(reviewRunDbId)
				).length;
			}
		} catch {
			// Best-effort only: the run's own status is still authoritative
			// even if the findings-count lookup fails transiently.
		}
	}
	return { ...run, summary: { ...EMPTY_SUMMARY, findings } };
}

async function resolveFindingsView(runId) {
	const livePipeline = getLivePipeline();
	if (!livePipeline) return [];
	const reviewRunDbId = livePipeline.getReviewRunDbId(runId);
	if (!reviewRunDbId) return [];
	return livePipeline.repository.listFindingsForReviewRun(reviewRunDbId);
}

function reviewRunStatus(runId) {
	return {
		id: runId,
		type: "review_run",
		thesis_document_id: null,
		status: "queued",
		progress_stage: "contract_stub",
		created_at: null,
		started_at: null,
		completed_at: null,
		failed_at: null,
		error_summary: null,
		summary: { pages: 0, sections: 0, findings: 0, reports: 0 },
	};
}

function parsePagination(query) {
	const page = Number(query.page ?? 1);
	const pageSize = Number(query.page_size ?? 50);
	const issues = [];
	if (!Number.isInteger(page) || page < 1)
		issues.push({
			field: "page",
			message: "Must be an integer greater than or equal to 1.",
		});
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
		issues.push({
			field: "page_size",
			message: "Must be an integer between 1 and 100.",
		});
	}
	if (issues.length) {
		return {
			error: errorResponse(
				422,
				"validation_error",
				"Request validation failed.",
				{ issues },
			),
		};
	}
	return { value: { page, page_size: pageSize } };
}

function paginated(items, pagination, filters) {
	return {
		items,
		total: items.length,
		page: pagination.page,
		page_size: pagination.page_size,
		filters,
	};
}

function pickFilters(query, names) {
	return Object.fromEntries(
		names
			.filter((name) => query[name] !== undefined)
			.map((name) => [name, query[name]]),
	);
}

function ok(body) {
	return { status: 200, body };
}

function errorResponse(status, error, message, details) {
	return {
		status,
		body: {
			error,
			message,
			details,
			request_id: "req_contract_stub",
			timestamp: new Date(0).toISOString(),
		},
	};
}
