/**
 * Pure, framework-free view-model + payload logic for the admin
 * `llm_provider_config` feature — mirrors `results-view.ts`'s pattern
 * (Work Unit 8 of `mvp-vertical-slice`): the decision of "what to render"
 * and "what to send" is a plain function, directly unit-testable with
 * `node:test` without an Angular TestBed/jsdom harness.
 * `admin-providers-page.ts` consumes this for its template branch, its
 * create/update request payloads, and its session-scoped admin-secret gate
 * (design decision #9).
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

/** Gates every admin request on a real, non-blank secret — never a silent skip. */
export function canSendAdminRequest(secret: string | null): boolean {
  return typeof secret === 'string' && secret.trim() !== '';
}

/**
 * Session-scoped admin-secret resolution (design decision #9): reuses an
 * already-cached secret without re-prompting; otherwise calls `promptFn`
 * (the real caller wires this to `window.prompt`, injected here so this
 * stays pure/testable) at most once. A blank entry or an explicit
 * cancellation (`null`) is treated as "no secret" — the caller must not
 * send a request in that case, never fabricate an empty-string secret.
 */
export function resolveAdminSecretForRequest(
  currentSecret: string | null,
  promptFn: () => string | null,
): string | null {
  if (canSendAdminRequest(currentSecret)) return currentSecret;
  const entered = promptFn();
  if (entered === null) return null;
  const trimmed = entered.trim();
  return trimmed === '' ? null : trimmed;
}

interface HttpErrorLike {
  status?: number;
  error?: { message?: string };
}

function isHttpErrorLike(err: unknown): err is HttpErrorLike {
  return typeof err === 'object' && err !== null && 'status' in err;
}

/** 401 (no secret sent) / 403 (wrong secret) — see spec's admin-gate scenarios. */
export function isAdminAuthError(err: unknown): boolean {
  if (!isHttpErrorLike(err)) return false;
  return err.status === 401 || err.status === 403;
}

/**
 * Never a silent failure: every admin request error surfaces a specific,
 * actionable message — distinguishing "no secret" (401) from "wrong
 * secret" (403) from the server's own validation/error message, with a
 * generic-but-visible fallback for anything else.
 */
export function extractAdminErrorMessage(err: unknown): string {
  if (isHttpErrorLike(err)) {
    if (err.status === 401) {
      return 'An admin secret is required to continue. Please try again.';
    }
    if (err.status === 403) {
      return 'The admin secret was rejected. Please re-enter it and try again.';
    }
    if (err.error?.message) return err.error.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return 'The admin request failed. Please try again.';
}
