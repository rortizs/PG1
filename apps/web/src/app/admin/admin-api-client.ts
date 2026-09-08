import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import {
  AdminProviderRow,
  CreateProviderPayload,
  UpdateProviderPayload,
  buildActivatePath,
  buildProviderPath,
} from './admin-providers-view';

const ADMIN_PROVIDERS_PATH = '/api/v1/admin/llm-providers';

interface AdminProvidersListResponse {
  items: AdminProviderRow[];
}

/**
 * Sibling admin HTTP client (design decision #8) — kept separate from
 * `ThesisApiClient` rather than extending it: different concern (admin
 * CRUD/activate). Auth is no longer this client's concern at all: every
 * authenticated reviewer is authorized for every route (reviewer-
 * authentication design decision D6 — no admin role, no `403` branch), and
 * `sessionInterceptor` attaches `Authorization: Bearer <token>` to this
 * client's requests the same way it does for every other same-origin
 * `/api/` call. This client is now a plain typed `HttpClient` wrapper,
 * mirroring `ThesisApiClient`.
 */
@Injectable({ providedIn: 'root' })
export class AdminApiClient {
  private readonly http = inject(HttpClient);

  listProviders(): Observable<AdminProviderRow[]> {
    return this.http
      .get<AdminProvidersListResponse>(ADMIN_PROVIDERS_PATH)
      .pipe(map((response) => response.items));
  }

  createProvider(payload: CreateProviderPayload): Observable<AdminProviderRow> {
    return this.http.post<AdminProviderRow>(ADMIN_PROVIDERS_PATH, payload);
  }

  updateProvider(id: number, payload: UpdateProviderPayload): Observable<AdminProviderRow> {
    return this.http.patch<AdminProviderRow>(buildProviderPath(id), payload);
  }

  activateProvider(id: number): Observable<AdminProviderRow> {
    return this.http.post<AdminProviderRow>(buildActivatePath(id), {});
  }
}
