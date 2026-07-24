import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { handleApiRequest } from '../api-contract.mjs';
import type { HttpResponse } from '../http-types.js';

/**
 * Real NestJS controller for review-run routes.
 *
 * Every method delegates to the existing pure `handleApiRequest` (which in
 * turn delegates to `review-run-lifecycle.mjs`) — no lifecycle/queue/report
 * logic is re-implemented here.
 */
@Controller('api/v1/review-runs')
export class ReviewRunsController {
  readonly routes = [
    'GET /api/v1/review-runs/{run_id}',
    'GET /api/v1/review-runs/{run_id}/findings',
    'GET /api/v1/review-runs/{run_id}/report-artifacts',
  ];

  @Get(':runId')
  async getRun(@Param('runId') runId: string, @Res() res: HttpResponse) {
    const result = await handleApiRequest({
      method: 'GET',
      path: `/api/v1/review-runs/${encodeURIComponent(runId)}`,
    });
    res.status(result.status).json(result.body);
  }

  @Get(':runId/findings')
  async getFindings(
    @Param('runId') runId: string,
    @Query() query: Record<string, string>,
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'GET',
      path: `/api/v1/review-runs/${encodeURIComponent(runId)}/findings`,
      query,
    });
    res.status(result.status).json(result.body);
  }

  @Get(':runId/report-artifacts')
  async getReportArtifacts(
    @Param('runId') runId: string,
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'GET',
      path: `/api/v1/review-runs/${encodeURIComponent(runId)}/report-artifacts`,
    });
    res.status(result.status).json(result.body);
  }
}
