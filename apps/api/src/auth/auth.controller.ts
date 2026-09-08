import { Body, Controller, Delete, Headers, Post, Res } from '@nestjs/common';
import { handleAuthRequest } from '../auth-contract.mjs';
import type { HttpResponse } from '../http-types.js';

/** Minimal structural shape of the headers this controller needs. */
interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Real NestJS controller for the public login/logout routes.
 *
 * reviewer-authentication design.md D7: both routes are public — no guard —
 * delegating whole to the isolated `handleAuthRequest` (design decision #7's
 * isolation split, same shape `AdminController` already uses for
 * `handleAdminRequest`) so `contract.test.mjs`'s assertions stay
 * byte-untouched.
 */
@Controller('api/v1/auth/sessions')
export class AuthController {
  readonly routes = ['POST /api/v1/auth/sessions', 'DELETE /api/v1/auth/sessions/current'];

  @Post()
  async login(
    @Body() body: unknown,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleAuthRequest({
      method: 'POST',
      path: '/api/v1/auth/sessions',
      body: body ?? {},
      headers,
    });
    res.status(result.status).json(result.body);
  }

  @Delete('current')
  async logout(@Headers() headers: RequestWithHeaders['headers'], @Res() res: HttpResponse) {
    const result = await handleAuthRequest({
      method: 'DELETE',
      path: '/api/v1/auth/sessions/current',
      headers,
    });
    res.status(result.status).json(result.body);
  }
}
