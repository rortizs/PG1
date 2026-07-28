import { Injectable, signal } from '@angular/core';
import { resolveAdminSecretForRequest } from './admin-providers-view';

/**
 * Session-scoped-only holder for the `x-admin-secret` value (design
 * decision #9): an in-memory Angular signal, alive only for this browser
 * tab's lifetime — NEVER localStorage (persists/leaks across sessions) and
 * NEVER build-time baked into the bundle (ships the secret in shipped JS).
 * A page refresh loses it; the admin is prompted again — an accepted MVP
 * tradeoff per `design.md`.
 */
@Injectable({ providedIn: 'root' })
export class AdminSecretStore {
  private readonly secret = signal<string | null>(null);

  /**
   * Resolves the secret for the current request: reuses the cached value
   * without re-prompting, or prompts (at most once per session, until
   * `clearSecret()` is called) via `promptFn` — defaults to a real
   * `window.prompt`, overridable for tests.
   */
  getSecret(
    promptFn: () => string | null = () =>
      window.prompt('Enter the admin shared secret for this session:'),
  ): string | null {
    const resolved = resolveAdminSecretForRequest(this.secret(), promptFn);
    this.secret.set(resolved);
    return resolved;
  }

  /**
   * Called after a `403` (wrong secret) so the very next admin action
   * re-prompts instead of silently repeating the same rejected value.
   */
  clearSecret(): void {
    this.secret.set(null);
  }
}
