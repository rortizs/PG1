import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { handleAdminRequest } from '../admin-contract.mjs';
import type { HttpResponse } from '../http-types.js';
import { AdminSecretGuard } from './admin-secret.guard.js';

/** Minimal structural shape of the headers this controller needs. */
interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Real NestJS controller for admin `llm_provider_config` routes.
 *
 * Every method delegates to the isolated, pure `handleAdminRequest` (design
 * decision #7) — no CRUD/encryption/masking logic is re-implemented here.
 * `AdminSecretGuard` rejects unauthenticated/unauthorized requests before
 * reaching these methods; `handleAdminRequest` independently re-checks the
 * same shared secret (defense-in-depth, and the sole enforcement path
 * exercised directly by `admin-contract.test.mjs`).
 */
@Controller('api/v1/admin/llm-providers')
@UseGuards(AdminSecretGuard)
export class AdminController {
  readonly routes = [
    'GET /api/v1/admin/llm-providers',
    'POST /api/v1/admin/llm-providers',
    'PATCH /api/v1/admin/llm-providers/{id}',
    'POST /api/v1/admin/llm-providers/{id}/activate',
  ];

  @Get()
  async list(@Headers() headers: RequestWithHeaders['headers'], @Res() res: HttpResponse) {
    const result = await handleAdminRequest({
      method: 'GET',
      path: '/api/v1/admin/llm-providers',
      headers,
    });
    res.status(result.status).json(result.body);
  }

  @Post()
  async create(
    @Body() body: unknown,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleAdminRequest({
      method: 'POST',
      path: '/api/v1/admin/llm-providers',
      body: body ?? {},
      headers,
    });
    res.status(result.status).json(result.body);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleAdminRequest({
      method: 'PATCH',
      path: `/api/v1/admin/llm-providers/${encodeURIComponent(id)}`,
      body: body ?? {},
      headers,
    });
    res.status(result.status).json(result.body);
  }

  @Post(':id/activate')
  async activate(
    @Param('id') id: string,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleAdminRequest({
      method: 'POST',
      path: `/api/v1/admin/llm-providers/${encodeURIComponent(id)}/activate`,
      headers,
    });
    res.status(result.status).json(result.body);
  }
}
