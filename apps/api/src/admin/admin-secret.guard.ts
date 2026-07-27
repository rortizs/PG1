import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { checkAdminSecretHeader } from '../admin-contract.mjs';

/**
 * Real NestJS transport-layer guard for admin routes (design decision #6):
 * an explicit, documented TEMPORARY MVP shared-secret gate, NOT real
 * authentication/authorization. Delegates the actual constant-time
 * `x-admin-secret` comparison to `admin-contract.mjs`'s
 * `checkAdminSecretHeader` — the single source of truth for that check,
 * directly unit-tested (without needing a live NestJS app) in
 * `admin-contract.test.mjs`. This guard exists purely to reject an
 * unauthorized request before it ever reaches a controller method,
 * providing defense-in-depth at the HTTP boundary.
 */
@Injectable()
export class AdminSecretGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const result = checkAdminSecretHeader(request.headers ?? {});
    if (result === null) return true;
    if (result.status === 401) throw new UnauthorizedException(result.body);
    throw new ForbiddenException(result.body);
  }
}
