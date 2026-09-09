import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import type { ReviewerSession } from './session-store';

const AUTH_SESSIONS_PATH = '/api/v1/auth/sessions';
const AUTH_SESSION_CURRENT_PATH = `${AUTH_SESSIONS_PATH}/current`;

interface LoginResponse {
  type: string;
  token: string;
  expires_at: string;
  reviewer: { id: number; email: string; display_name: string };
}

/**
 * Thin typed HTTP client for the reviewer-authentication routes
 * (`POST`/`DELETE /api/v1/auth/sessions*`, design decision D7). Mirrors
 * `ThesisApiClient`'s pattern: plain `HttpClient` calls, no manual header
 * plumbing — `sessionInterceptor` supplies `Authorization` for every
 * request that needs it.
 */
@Injectable({ providedIn: 'root' })
export class AuthApiClient {
  private readonly http = inject(HttpClient);

  login(email: string, password: string): Observable<ReviewerSession> {
    return this.http
      .post<LoginResponse>(AUTH_SESSIONS_PATH, { email, password })
      .pipe(
        map((response) => ({
          token: response.token,
          reviewerId: response.reviewer.id,
          email: response.reviewer.email,
          displayName: response.reviewer.display_name,
          expiresAt: response.expires_at,
        })),
      );
  }

  logout(): Observable<void> {
    return this.http.delete<void>(AUTH_SESSION_CURRENT_PATH);
  }
}
