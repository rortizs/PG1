/**
 * NestJS-compatible controller seam for thesis document routes.
 *
 * Decorators and framework binding are deferred until the real NestJS package
 * is introduced. This class records route ownership without implementing
 * storage, upload handling, or framework HTTP behavior.
 */
export class ThesisDocumentsController {
	readonly routes = [
		"POST /api/v1/thesis-documents",
		"GET /api/v1/thesis-documents",
		"POST /api/v1/thesis-documents/{document_id}/review-runs",
	];
}
