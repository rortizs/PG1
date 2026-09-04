/**
 * Pure, framework-free view-model + payload logic for the admin
 * `llm_provider_config` feature — mirrors `results-view.ts`'s pattern
 * (Work Unit 8 of `mvp-vertical-slice`): the decision of "what to render"
 * and "what to send" is a plain function, directly unit-testable with
 * `node:test` without an Angular TestBed/jsdom harness.
 * `admin-providers-page.ts` consumes this for its template branch and its
 * create/update request payloads. Authentication/authorization is no longer
 * this module's concern (reviewer-authentication `SessionStore`/
 * `sessionInterceptor` own it now); this file only classifies and surfaces
 * request errors.
 */

export interface AdminProviderRow {
  id: number;
  type: string;
  provider_name: string;
  model_id: string;
  api_key_last_four: string;
  is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type AdminProvidersViewModel =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'list'; items: AdminProviderRow[] };

export function buildAdminProvidersViewModel({
  providers,
  loadError,
}: {
  providers: AdminProviderRow[] | null;
  loadError: string | null;
}): AdminProvidersViewModel {
  if (loadError) return { kind: 'error', message: loadError };
  if (providers === null) return { kind: 'loading' };
  return { kind: 'list', items: providers };
}

/**
 * The API never returns anything but `api_key_last_four` (design decision
 * #6 / spec's "Provider CRUD via Admin API" requirement) — this is the ONLY
 * place a stored key's characters are ever rendered, and it can only ever
 * render the last four.
 */
export function maskedKeyLabel(row: Pick<AdminProviderRow, 'api_key_last_four'>): string {
  return `••••${row.api_key_last_four}`;
}

export interface AdminProviderFormValue {
  providerName: string;
  modelId: string;
  apiKey: string;
}

export interface CreateProviderPayload {
  provider_name: string;
  model_id: string;
  api_key: string;
}

/** Create always requires a real key — the field is required on this form. */
export function buildCreateProviderPayload(
  form: AdminProviderFormValue,
): CreateProviderPayload {
  return {
    provider_name: form.providerName,
    model_id: form.modelId,
    api_key: form.apiKey,
  };
}

export interface UpdateProviderPayload {
  model_id?: string;
  api_key?: string;
}

/**
 * The raw API key field is write-only (never pre-filled with a real value
 * on edit — see `admin-providers-page.ts`'s `onEdit`). Leaving it blank on
 * an update means "don't change the stored key" — `api_key` is omitted from
 * the payload entirely in that case, never sent as an empty string that
 * could accidentally overwrite the stored key.
 */
export function buildUpdateProviderPayload(form: {
  modelId: string;
  apiKey: string;
}): UpdateProviderPayload {
  const payload: UpdateProviderPayload = { model_id: form.modelId };
  if (form.apiKey.trim() !== '') {
    payload.api_key = form.apiKey;
  }
  return payload;
}

const ADMIN_PROVIDERS_BASE_PATH = '/api/v1/admin/llm-providers';

export function buildProviderPath(id: number): string {
  return `${ADMIN_PROVIDERS_BASE_PATH}/${encodeURIComponent(String(id))}`;
}

export function buildActivatePath(id: number): string {
  return `${buildProviderPath(id)}/activate`;
}

interface HttpErrorLike {
  status?: number;
  error?: { message?: string };
}

function isHttpErrorLike(err: unknown): err is HttpErrorLike {
  return typeof err === 'object' && err !== null && 'status' in err;
}

/**
 * `401` under session auth means "no valid reviewer session" (D6 — there is
 * no `403` branch: every authenticated reviewer is authorized for every
 * route, admin included). `sessionInterceptor` already clears the store and
 * routes to `/login` on `401`; this only classifies the error so the page
 * can still surface a message for the brief moment before that redirect.
 */
export function isAdminAuthError(err: unknown): boolean {
  if (!isHttpErrorLike(err)) return false;
  return err.status === 401;
}

/**
 * Never a silent failure: every admin request error surfaces a specific,
 * actionable message, distinguishing "session required" (401) from the
 * server's own validation/error message, with a generic-but-visible
 * fallback for anything else.
 */
export function extractAdminErrorMessage(err: unknown): string {
  if (isHttpErrorLike(err)) {
    if (err.status === 401) {
      return 'Your session has expired. Please sign in again.';
    }
    if (err.error?.message) return err.error.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return 'The admin request failed. Please try again.';
}
