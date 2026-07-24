import { createReviewRunLifecycleService } from "./review-runs/review-run-lifecycle.mjs";
import { processThesisDocumentUpload } from "./thesis-documents/upload-service.mjs";

const reviewRunLifecycle = createReviewRunLifecycleService();

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

export function handleApiRequest({ method, path, query = {}, body = {} }) {
	const normalizedMethod = method.toUpperCase();
	const pagination = parsePagination(query);
	if (pagination.error) return pagination.error;

	if (normalizedMethod === "POST" && path === "/api/v1/thesis-documents") {
		if (body.files !== undefined) {
			return processThesisDocumentUpload({
				files: body.files,
				uploaderUserId: body.uploaderUserId ?? null,
				metadata: body.metadata ?? {},
			});
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
		return reviewRunLifecycle.startReviewRun({
			documentId: decodeURIComponent(reviewRunCreate[1]),
			pipelineVersion: body.pipelineVersion ?? "pipeline-v1",
		});
	}

	const reviewRun = path.match(/^\/api\/v1\/review-runs\/([^/]+)$/);
	if (normalizedMethod === "GET" && reviewRun) {
		return ok(reviewRunStatus(decodeURIComponent(reviewRun[1])));
	}

	const findings = path.match(/^\/api\/v1\/review-runs\/([^/]+)\/findings$/);
	if (normalizedMethod === "GET" && findings) {
		return ok({
			review_run_id: decodeURIComponent(findings[1]),
			...paginated(
				[],
				pagination.value,
				pickFilters(query, ["type", "severity"]),
			),
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
