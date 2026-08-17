import { Module } from "@nestjs/common";
import { AdminController } from "./admin/admin.controller.js";
import { ReviewBoardController } from "./review-board/review-board.controller.js";
import { ReviewRunsController } from "./review-runs/review-runs.controller.js";
import { ThesisDocumentsController } from "./thesis-documents/thesis-documents.controller.js";

/**
 * Real NestJS module wiring for the PG1 API contract slice.
 *
 * Controllers own route ownership and delegate request handling to the
 * existing pure `handleApiRequest`/service logic — no product logic lives
 * here. `AdminController` delegates to the isolated `admin-contract.mjs`
 * instead (design decision #7) so `contract.test.mjs`'s assertions stay
 * byte-untouched.
 */
@Module({
	controllers: [
		ThesisDocumentsController,
		ReviewRunsController,
		ReviewBoardController,
		AdminController,
	],
})
export class Pg1ApiModule {}
