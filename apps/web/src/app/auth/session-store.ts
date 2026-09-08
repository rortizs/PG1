import { Injectable, computed, signal } from '@angular/core';

/**
 * The shape of an established reviewer session, returned by
 * `AuthApiClient.login()` and held by `SessionStore`.
 */
export interface ReviewerSession {
  token: string;
  reviewerId: number;
  email: string;
  displayName: string;
  expiresAt: string;
}

/**
 * In-memory-only (design decision D9) holder for the current reviewer
 * session — an Angular signal, alive only for this browser tab's lifetime.
 * NEVER localStorage/sessionStorage (persists/leaks a bearer token across
 * sessions or tabs) and NEVER build-time baked into the bundle. A page
 * refresh loses it; the reviewer signs in again — the same accepted MVP
 * tradeoff `admin-secret-store.ts` made for the (now retired) admin secret.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly session = signal<ReviewerSession | null>(null);

  readonly isAuthenticated = computed(() => this.session() !== null);
  readonly displayName = computed(() => this.session()?.displayName ?? null);

  setSession(session: ReviewerSession): void {
    this.session.set(session);
  }

  clearSession(): void {
    this.session.set(null);
  }

  token(): string | null {
    return this.session()?.token ?? null;
  }
}
