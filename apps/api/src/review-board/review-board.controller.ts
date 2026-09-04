import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { handleApiRequest } from '../api-contract.mjs';
import { SessionGuard } from '../auth/session.guard.js';
import type { HttpResponse } from '../http-types.js';

/** Minimal structural shape of the headers this controller needs. */
interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

@Controller('api/v1/review-board/cards')
@UseGuards(SessionGuard)
export class ReviewBoardController {
  readonly routes = [
    'GET /api/v1/review-board/cards',
    'PATCH /api/v1/review-board/cards/{card_id}/priority',
    'POST /api/v1/review-board/cards/{card_id}/approval',
  ];

  @Get()
  async list(
    @Query() query: Record<string, string>,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'GET',
      path: '/api/v1/review-board/cards',
      query,
      headers,
    });
    res.status(result.status).json(result.body);
  }

  @Patch(':cardId/priority')
  async updatePriority(
    @Param('cardId') cardId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'PATCH',
      path: `/api/v1/review-board/cards/${encodeURIComponent(cardId)}/priority`,
      body,
      headers,
    });
    res.status(result.status).json(result.body);
  }

  @Post(':cardId/approval')
  async approve(
    @Param('cardId') cardId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'POST',
      path: `/api/v1/review-board/cards/${encodeURIComponent(cardId)}/approval`,
      body,
      headers,
    });
    res.status(result.status).json(result.body);
  }
}
