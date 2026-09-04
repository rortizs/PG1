import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { checkSession, resolveReviewerRepository } from '../auth-contract.mjs';

/** Minimal structural shape of the headers this guard needs. */
interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * reviewer-authentication design.md D6: real NestJS transport-layer guard
 * requiring a valid reviewer session on every route it protects — the
 * permanent replacement for `AdminSecretGuard`'s temporary MVP shared
 * secret (design decision #11, retired this unit). Same shape as
 * `AdminSecretGuard`, async because the session lives in Postgres, not an
 * env var. There is **no** `403` branch: with no admin role, "wrong secret"
 * has no analogue — every authenticated reviewer is authorized for every
 * route, exactly as confirmed.
 *
 * Deviation from design.md D6's literal `checkSession(headers, {})` code
 * sample: `checkSession` (Unit 1, already implemented and tested via
 * fake-repo cases) takes an explicitly injected `repository` and does not
 * resolve one on its own, so this guard resolves the reviewer repository
 * itself via `resolveReviewerRepository()` (added this unit as a pure
 * addition to `auth-contract.mjs` — zero changes to `checkSession`'s or
 * `verifyCredentials`'s existing logic) and surfaces the `DATABASE_URL`-unset
 * 503 case from that resolution step instead of from `checkSession` itself.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithHeaders>();
    const resolved = resolveReviewerRepository();
    if (resolved.error) {
      throw new ServiceUnavailableException(resolved.error.body);
    }
    const { error } = await checkSession(request.headers ?? {}, {
      repository: resolved.repository,
    });
    if (!error) return true;
    if (error.status === 401) throw new UnauthorizedException(error.body);
    throw new ServiceUnavailableException(error.body);
  }
}
