import type { CanActivateFn } from '@angular/router';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { SessionStore } from './session-store';

/**
 * Route guard (design decision D9): an authenticated session passes
 * through untouched (no redirect loop on an already-signed-in reviewer);
 * anywhere else redirects to `/login`, carrying the originally-requested
 * URL as `redirectTo` so `LoginPage` can send the reviewer back to where
 * they meant to go instead of always defaulting to `/upload`.
 */
export const requireSession: CanActivateFn = (_route, state) => {
  const sessionStore = inject(SessionStore);
  if (sessionStore.isAuthenticated()) return true;

  const router = inject(Router);
  return router.createUrlTree(['/login'], { queryParams: { redirectTo: state.url } });
};
