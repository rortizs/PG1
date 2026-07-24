import { Module } from '@nestjs/common';
import { ReviewRunsController } from './review-runs/review-runs.controller.js';
import { ThesisDocumentsController } from './thesis-documents/thesis-documents.controller.js';

/**
 * Real NestJS module wiring for the PG1 API contract slice.
 *
 * Controllers own route ownership and delegate request handling to the
 * existing pure `handleApiRequest`/service logic — no product logic lives
 * here.
 */
@Module({
  controllers: [ThesisDocumentsController, ReviewRunsController],
})
export class Pg1ApiModule {}
