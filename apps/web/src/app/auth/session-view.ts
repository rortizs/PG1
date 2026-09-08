/**
 * Pure, framework-free view-model + security logic for the reviewer
 * authentication feature (design decision D9). Mirrors
 * `admin-providers-view.ts`'s precedent of parking pure logic in a
 * `*-view.ts` sibling so it is directly unit-testable with `node:test`,
 * without an Angular TestBed/jsdom harness.
 *
 * `shouldAttachToken` is a real security boundary, not just a UX nicety: a
 * blanket bearer-token interceptor is how tokens leak to third-party hosts
 * (analytics, CDNs) or get replayed against the login endpoint itself. It is
 * exercised thoroughly here (OWASP A01/A02 — broken access control /
 * cryptographic-material handling).
 */

/** Matches `auth-contract.mjs`'s `MIN_PASSWORD_LENGTH` (D3) — the CLI, the
 * API and this form must never disagree about what a valid password is. */
const MIN_PASSWORD_LENGTH = 12;

/** Simple, deliberately permissive shape check — the server is the source
 * of truth for "does this account exist"; this only rejects obviously
 * malformed input before a network round-trip. */
const EMAIL_SHAPE_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The login-creation route itself — never attach a (possibly stale) bearer
 * token to the request that is establishing a brand new one. */
const LOGIN_CREATE_PATH = '/api/v1/auth/sessions';

/** Same-origin API prefix. Anything outside this prefix never receives the
 * token, regardless of how it is spelled. */
const API_PATH_PREFIX = '/api/';

export function loginFormIssues(email: string, password: string): string[] {
  const issues: string[] = [];

  const trimmedEmail = email.trim();
  if (trimmedEmail === '') {
    issues.push('Email is required.');
  } else if (!EMAIL_SHAPE_PATTERN.test(trimmedEmail)) {
    issues.push('Enter a valid email address.');
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  return issues;
}

export function buildAuthorizationHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * True only for a same-origin `/api/` path that is not the login-creation
 * route itself. False for:
 * - a missing token (nothing to attach),
 * - any absolute URL (`scheme://…` or protocol-relative `//…`) — a
 *   same-origin relative path is the only shape ever trusted,
 * - a relative path outside `/api/` (e.g. a static asset),
 * - `POST /api/v1/auth/sessions` exactly (the logout route
 *   `/api/v1/auth/sessions/current` is a *different* path and DOES receive
 *   the token — it needs it to identify which session to revoke).
 */
export function shouldAttachToken(url: string, token: string | null): boolean {
  if (!token) return false;
  if (isAbsoluteUrl(url)) return false;
  if (!url.startsWith(API_PATH_PREFIX)) return false;
  if (isLoginCreatePath(url)) return false;
  return true;
}

function isAbsoluteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith('//');
}

function isLoginCreatePath(url: string): boolean {
  const pathOnly = url.split(/[?#]/)[0];
  return pathOnly === LOGIN_CREATE_PATH;
}
