import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { SessionStore } from './session-store';
import { buildAuthorizationHeader, shouldAttachToken } from './session-view';

/**
 * Attaches `Authorization: Bearer <token>` to every same-origin `/api/`
 * request except the login-creation route itself, per `shouldAttachToken`
 * (design decision D9 — a real security boundary, not just plumbing). On a
 * `401` response it clears the session store and routes to `/login`, so a
 * revoked/expired token cannot loop silently — the reviewer always lands on
 * a real sign-in prompt instead of a stuck spinner or a repeated 401.
 */
export const sessionInterceptor: HttpInterceptorFn = (req, next) => {
  const sessionStore = inject(SessionStore);
  const router = inject(Router);
  const token = sessionStore.token();

  const outgoingReq = shouldAttachToken(req.url, token)
    ? req.clone({ setHeaders: buildAuthorizationHeader(token as string) })
    : req;

  return next(outgoingReq).pipe(
    catchError((err: unknown) => {
      if (isUnauthorized(err)) {
        sessionStore.clearSession();
        void router.navigate(['/login']);
      }
      return throwError(() => err);
    }),
  );
};

function isUnauthorized(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 401;
}
