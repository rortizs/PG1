/**
 * NestJS-compatible controller seam for review-run routes.
 *
 * Decorators and framework binding are deferred until the real NestJS package
 * is introduced. This class records route ownership without implementing DB,
 * queue, RAG, or report generation behavior.
 */
export class ReviewRunsController {
	readonly routes = [
		"GET /api/v1/review-runs/{run_id}",
		"GET /api/v1/review-runs/{run_id}/findings",
		"GET /api/v1/review-runs/{run_id}/report-artifacts",
	];
}
