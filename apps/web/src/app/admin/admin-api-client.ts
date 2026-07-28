import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, defer, map, throwError } from 'rxjs';
import { AdminSecretStore } from './admin-secret-store';
import {
  AdminProviderRow,
  CreateProviderPayload,
  UpdateProviderPayload,
  buildActivatePath,
  buildProviderPath,
  canSendAdminRequest,
} from './admin-providers-view';

const ADMIN_PROVIDERS_PATH = '/api/v1/admin/llm-providers';
const ADMIN_SECRET_HEADER = 'x-admin-secret';

interface AdminProvidersListResponse {
  items: AdminProviderRow[];
}

/**
 * Sibling admin HTTP client (design decision #8) — kept separate from
 * `ThesisApiClient` rather than extending it: different concern (admin
 * CRUD/activate) and a different auth mechanism (the `x-admin-secret`
 * shared-secret header), so the thesis-upload/results client stays clean
 * and free of admin-only auth plumbing.
 *
 * Every method resolves the session-scoped admin secret (`AdminSecretStore`,
 * design decision #9) lazily, at SUBSCRIBE time (`defer`) — not at
 * construction or call time — so a session-first prompt only ever appears
 * when a real request is about to be made. A missing secret (the admin
 * cancelled the prompt) never silently sends an unauthenticated request —
 * it errors immediately, client-side, before any HTTP call is made.
 */
@Injectable({ providedIn: 'root' })
export class AdminApiClient {
  private readonly http = inject(HttpClient);
  private readonly secretStore = inject(AdminSecretStore);

  listProviders(): Observable<AdminProviderRow[]> {
    return this.withSecret((headers) =>
      this.http
        .get<AdminProvidersListResponse>(ADMIN_PROVIDERS_PATH, { headers })
        .pipe(map((response) => response.items)),
    );
  }

  createProvider(payload: CreateProviderPayload): Observable<AdminProviderRow> {
    return this.withSecret((headers) =>
      this.http.post<AdminProviderRow>(ADMIN_PROVIDERS_PATH, payload, { headers }),
    );
  }

  updateProvider(id: number, payload: UpdateProviderPayload): Observable<AdminProviderRow> {
    return this.withSecret((headers) =>
      this.http.patch<AdminProviderRow>(buildProviderPath(id), payload, { headers }),
    );
  }

  activateProvider(id: number): Observable<AdminProviderRow> {
    return this.withSecret((headers) =>
      this.http.post<AdminProviderRow>(buildActivatePath(id), {}, { headers }),
    );
  }

  private withSecret<T>(
    request: (headers: Record<string, string>) => Observable<T>,
  ): Observable<T> {
    return defer(() => {
      const secret = this.secretStore.getSecret();
      if (!canSendAdminRequest(secret)) {
        return throwError(
          () => new Error('An admin secret is required to continue.'),
        );
      }
      return request({ [ADMIN_SECRET_HEADER]: secret as string });
    });
  }
}
