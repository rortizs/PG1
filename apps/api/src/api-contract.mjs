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
// llm-provider-admin Work Unit 8: every review-run response carries these
// two fields (spec's "Backoffice Provider Visibility & Run Provenance"
// requirement) — `null` for stub/never-completed/pre-provenance runs, never
// an error or an omitted field, so callers can rely on the shape.
const EMPTY_PROVENANCE = { llm_provider_name: null, llm_model_id: null };

const ROUTES = [
	["POST", "/api/v1/thesis-documents"],
	["GET", "/api/v1/thesis-documents"],
	["POST", "/api/v1/thesis-documents/{document_id}/review-runs"],
	["GET", "/api/v1/review-runs/{run_id}"],
	["GET", "/api/v1/review-runs/{run_id}/findings"],
	["GET", "/api/v1/review-runs/{run_id}/report-artifacts"],
	["GET", "/api/v1/review-board/cards"],
	["PATCH", "/api/v1/review-board/cards/{card_id}/priority"],
	["POST", "/api/v1/review-board/cards/{card_id}/approval"],
];

export function listApiRoutes() {
	return ROUTES.map(([method, path]) => ({ method, path }));
}

export async function handleApiRequest({
	method,
	path,
	query = {},
	body = {},
}) {
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
						metadata: result.body.metadata,
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

	if (normalizedMethod === "GET" && path === "/api/v1/review-board/cards") {
		const repository = resolveBoardRepository();
		const items = repository ? await repository.listReviewBoardCards() : [];
		return ok(
			paginated(
				items,
				pagination.value,
				pickFilters(query, ["state", "priority"]),
			),
		);
	}

	const priorityUpdate = path.match(
		/^\/api\/v1\/review-board\/cards\/([^/]+)\/priority$/,
	);
	if (normalizedMethod === "PATCH" && priorityUpdate) {
		const repository = resolveBoardRepository();
		if (!repository) return boardRepositoryUnavailable();
		const priority = String(body.priority ?? "").toLowerCase();
		if (!["low", "normal", "urgent"].includes(priority)) {
			return errorResponse(
				422,
				"validation_error",
				"Priority must be low, normal, or urgent.",
				{
					issues: [
						{
							field: "priority",
							message: "Must be one of: low, normal, urgent.",
						},
					],
				},
			);
		}
		try {
			const card = await repository.updateReviewBoardPriority(
				decodeURIComponent(priorityUpdate[1]),
				priority,
			);
			return card
				? ok(card)
				: errorResponse(404, "not_found", "Review-board card was not found.", {
						card_id: decodeURIComponent(priorityUpdate[1]),
					});
		} catch (error) {
			return errorResponse(
				422,
				"validation_error",
				"Review-board priority could not be updated.",
				{
					reason: error.message,
				},
			);
		}
	}

	const approval = path.match(
		/^\/api\/v1\/review-board\/cards\/([^/]+)\/approval$/,
	);
	if (normalizedMethod === "POST" && approval) {
		const repository = resolveBoardRepository();
		if (!repository) return boardRepositoryUnavailable();
		try {
			const card = await repository.approveReviewBoardCard(
				decodeURIComponent(approval[1]),
				{ reviewerName: body.reviewerName ?? body.reviewer_name ?? null },
			);
			return card
				? ok(card)
				: errorResponse(404, "not_found", "Review-board card was not found.", {
						card_id: decodeURIComponent(approval[1]),
					});
		} catch (error) {
			return errorResponse(
				422,
				"validation_error",
				"Review-board approval could not be recorded.",
				{
					reason: error.message,
				},
			);
		}
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
			const lifecycle = livePipeline
				? livePipeline.lifecycle
				: reviewRunLifecycle;
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
			...paginated(
				items,
				pagination.value,
				pickFilters(query, ["type", "severity"]),
			),
		});
	}

	const artifacts = path.match(
		/^\/api\/v1\/review-runs\/([^/]+)\/report-artifacts$/,
	);
	if (normalizedMethod === "GET" && artifacts) {
		const runId = decodeURIComponent(artifacts[1]);
		const artifact = await resolveMarkdownReportArtifact(runId);
		return ok({
			review_run_id: runId,
			status: artifact ? "available" : "pending",
			items: artifact ? [artifact] : [],
		});
	}

	return errorResponse(404, "not_found", "API route was not found.", {
		method: normalizedMethod,
		path,
	});
}

function resolveBoardRepository() {
	return getLivePipeline()?.repository ?? null;
}

function boardRepositoryUnavailable() {
	return errorResponse(
		503,
		"service_unavailable",
		"Review-board workflow persistence is not available.",
		{ reason: "DATABASE_URL is not configured" },
	);
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
		return {
			...result.body,
			summary: { ...EMPTY_SUMMARY },
			...EMPTY_PROVENANCE,
		};
	} catch {
		// Not a stub-lifecycle run either — fall through to the legacy stub.
	}
	return reviewRunStatus(runId);
}

async function withRealSummary(run, livePipeline, runId) {
	let findings = 0;
	let provenance = { ...EMPTY_PROVENANCE };
	if (run.status === "completed") {
		try {
			const reviewRunDbId = livePipeline.getReviewRunDbId(runId);
			if (reviewRunDbId) {
				findings = (
					await livePipeline.repository.listFindingsForReviewRun(reviewRunDbId)
				).length;
				// llm-provider-admin Work Unit 8: which provider/model handled
				// this run. A run completed before this change (or whose
				// provenance was never recorded for any other reason) has NULL
				// columns — `getReviewRunProvenance` already returns those as a
				// graceful `{ llmProviderName: null, llmModelId: null }`, never an
				// error, so the response always has this shape.
				const runProvenance =
					await livePipeline.repository.getReviewRunProvenance(reviewRunDbId);
				if (runProvenance) {
					provenance = {
						llm_provider_name: runProvenance.llmProviderName,
						llm_model_id: runProvenance.llmModelId,
					};
				}
			}
		} catch {
			// Best-effort only: the run's own status is still authoritative
			// even if the findings-count/provenance lookup fails transiently.
		}
	}
	return { ...run, summary: { ...EMPTY_SUMMARY, findings }, ...provenance };
}

async function resolveFindingsView(runId) {
	const livePipeline = getLivePipeline();
	if (!livePipeline) return [];
	const reviewRunDbId = livePipeline.getReviewRunDbId(runId);
	if (!reviewRunDbId) return [];
	return livePipeline.repository.listFindingsForReviewRun(reviewRunDbId);
}

async function resolveMarkdownReportArtifact(runId) {
	const run = await resolveExistingReviewRunView(runId);
	if (!run) return null;
	const findings = await resolveFindingsView(runId);
	return {
		id: `${runId}-markdown-report`,
		kind: "markdown",
		filename: `review-run-${runId}-report.md`,
		content_type: "text/markdown; charset=utf-8",
		content: buildMarkdownReviewReport({ run, findings }),
	};
}

async function resolveExistingReviewRunView(runId) {
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
		return {
			...result.body,
			summary: { ...EMPTY_SUMMARY },
			...EMPTY_PROVENANCE,
		};
	} catch {
		return null;
	}
}

function buildMarkdownReviewReport({ run, findings }) {
	const findingCount = findings.length;
	return [
		"# Thesis Review Report",
		"",
		"## Executive Summary",
		`Review run ${run.id} is currently ${formatValue(run.status)}. ${summarizeFindings(findingCount)}`,
		"",
		"## Overall Verdict / Readiness",
		readinessText(run, findings),
		"",
		"## Finding Counts by Severity",
		formatSeverityCounts(findings),
		"",
		"## Detailed Findings",
		formatDetailedFindings(findings),
		"",
		"## Evidence",
		formatEvidence(findings),
		"",
		"## Recommended Actions",
		formatRecommendedActions(findings),
		"",
	].join("\n");
}

function summarizeFindings(findingCount) {
	if (findingCount === 0) {
		return "No findings were recorded for this review run.";
	}
	return `${findingCount} finding${findingCount === 1 ? " was" : "s were"} recorded for this review run.`;
}

function readinessText(run, findings) {
	if (findings.length === 0) {
		return run.status === "completed"
			? "No recorded findings block thesis readiness based on the available review data."
			: "The run exists, but the review is not completed yet; treat this report as preliminary.";
	}
	if (
		findings.some((finding) => ["critical", "high"].includes(finding.severity))
	) {
		return "Revision is required before the thesis should be treated as review-ready.";
	}
	return "Revision is recommended before final thesis approval.";
}

function formatSeverityCounts(findings) {
	if (findings.length === 0) {
		return "No severity counts are available because no findings were recorded.";
	}
	const counts = findings.reduce((acc, finding) => {
		const severity = formatValue(finding.severity);
		acc[severity] = (acc[severity] ?? 0) + 1;
		return acc;
	}, {});
	return Object.entries(counts)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([severity, count]) => `- ${severity}: ${count}`)
		.join("\n");
}

function formatDetailedFindings(findings) {
	if (findings.length === 0) {
		return "No findings were recorded for this review run.";
	}
	return findings
		.map((finding, index) => {
			const lines = [
				`### ${index + 1}. ${formatValue(finding.title, "Untitled finding")}`,
				"",
				`- Severity: ${formatValue(finding.severity)}`,
				`- Type: ${formatValue(finding.finding_type)}`,
			];
			if (finding.confidence != null)
				lines.push(`- Confidence: ${finding.confidence}`);
			lines.push(
				"",
				formatValue(finding.explanation, "No explanation provided."),
			);
			return lines.join("\n");
		})
		.join("\n\n");
}

function formatEvidence(findings) {
	if (findings.length === 0) {
		return "No evidence snippets were recorded for this review run.";
	}
	return findings
		.map((finding, index) => {
			const location = [];
			if (finding.page_number != null)
				location.push(`Page ${finding.page_number}`);
			if (finding.section_title)
				location.push(`Section: ${finding.section_title}`);
			return [
				`### Finding ${index + 1}: ${formatValue(finding.title, "Untitled finding")}`,
				"",
				`- Location: ${location.length ? location.join("; ") : "Not available"}`,
				"",
				`> ${formatValue(finding.evidence_text, "No evidence text provided.")}`,
			].join("\n");
		})
		.join("\n\n");
}

function formatRecommendedActions(findings) {
	if (findings.length === 0) {
		return "Continue with the existing thesis review workflow and record any future reviewer observations as findings.";
	}
	return findings
		.map(
			(finding, index) =>
				`${index + 1}. ${formatValue(finding.recommendation, "Review and resolve the finding before approval.")}`,
		)
		.join("\n");
}

function formatValue(value, fallback = "Not available") {
	if (value === null || value === undefined || value === "") return fallback;
	return String(value).trim() || fallback;
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
		...EMPTY_PROVENANCE,
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
