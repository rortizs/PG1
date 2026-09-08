import { Controller, Get, Headers, Param, Query, Res, UseGuards } from '@nestjs/common';
import { handleApiRequest } from '../api-contract.mjs';
import { SessionGuard } from '../auth/session.guard.js';
import type { HttpResponse } from '../http-types.js';

/** Minimal structural shape of the headers this controller needs. */
interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Real NestJS controller for review-run routes.
 *
 * Every method delegates to the existing pure `handleApiRequest` (which in
 * turn delegates to `review-run-lifecycle.mjs`) — no lifecycle/queue/report
 * logic is re-implemented here.
 */
@Controller('api/v1/review-runs')
@UseGuards(SessionGuard)
export class ReviewRunsController {
  readonly routes = [
    'GET /api/v1/review-runs/{run_id}',
    'GET /api/v1/review-runs/{run_id}/findings',
    'GET /api/v1/review-runs/{run_id}/report-artifacts',
  ];

  @Get(':runId')
  async getRun(
    @Param('runId') runId: string,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'GET',
      path: `/api/v1/review-runs/${encodeURIComponent(runId)}`,
      headers,
    });
    res.status(result.status).json(result.body);
  }

  @Get(':runId/findings')
  async getFindings(
    @Param('runId') runId: string,
    @Query() query: Record<string, string>,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'GET',
      path: `/api/v1/review-runs/${encodeURIComponent(runId)}/findings`,
      query,
      headers,
    });
    res.status(result.status).json(result.body);
  }

  @Get(':runId/report-artifacts')
  async getReportArtifacts(
    @Param('runId') runId: string,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'GET',
      path: `/api/v1/review-runs/${encodeURIComponent(runId)}/report-artifacts`,
      headers,
    });
    res.status(result.status).json(result.body);
  }
}
