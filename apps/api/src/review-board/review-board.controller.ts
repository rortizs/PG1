import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { handleApiRequest } from '../api-contract.mjs';
import type { HttpResponse } from '../http-types.js';

@Controller('api/v1/review-board/cards')
export class ReviewBoardController {
  readonly routes = [
    'GET /api/v1/review-board/cards',
    'PATCH /api/v1/review-board/cards/{card_id}/priority',
    'POST /api/v1/review-board/cards/{card_id}/approval',
  ];

  @Get()
  async list(@Query() query: Record<string, string>, @Res() res: HttpResponse) {
    const result = await handleApiRequest({
      method: 'GET',
      path: '/api/v1/review-board/cards',
      query,
    });
    res.status(result.status).json(result.body);
  }

  @Patch(':cardId/priority')
  async updatePriority(
    @Param('cardId') cardId: string,
    @Body() body: Record<string, unknown>,
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'PATCH',
      path: `/api/v1/review-board/cards/${encodeURIComponent(cardId)}/priority`,
      body,
    });
    res.status(result.status).json(result.body);
  }

  @Post(':cardId/approval')
  async approve(
    @Param('cardId') cardId: string,
    @Body() body: Record<string, unknown>,
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'POST',
      path: `/api/v1/review-board/cards/${encodeURIComponent(cardId)}/approval`,
      body,
    });
    res.status(result.status).json(result.body);
  }
}
