import { ReviewRunsController } from "./review-runs/review-runs.controller";
import { ThesisDocumentsController } from "./thesis-documents/thesis-documents.controller";

/**
 * NestJS-compatible module seam for the PG1 API contract slice.
 *
 * Real `@Module()` wiring is introduced when NestJS dependencies are added.
 * Until then, this keeps route ownership explicit and testable without a
 * framework generator.
 */
export class Pg1ApiModule {
	readonly controllers = [ThesisDocumentsController, ReviewRunsController];
}
