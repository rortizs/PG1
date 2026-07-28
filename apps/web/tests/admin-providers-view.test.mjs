import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdminProvidersViewModel,
  maskedKeyLabel,
  buildCreateProviderPayload,
  buildUpdateProviderPayload,
  buildProviderPath,
  buildActivatePath,
  canSendAdminRequest,
  resolveAdminSecretForRequest,
  extractAdminErrorMessage,
  isAdminAuthError,
} from '../src/app/admin/admin-providers-view.ts';

function providerRow(overrides = {}) {
  return {
    id: 1,
    type: 'llm_provider_config',
    provider_name: 'claude',
    model_id: 'claude-sonnet-4-20250514',
    api_key_last_four: '9k2p',
    is_active: false,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- empty list ---

test('buildAdminProvidersViewModel shows loading before providers have loaded', () => {
  const view = buildAdminProvidersViewModel({ providers: null, loadError: null });
  assert.deepEqual(view, { kind: 'loading' });
});

test('buildAdminProvidersViewModel shows an empty list state with zero rows', () => {
  const view = buildAdminProvidersViewModel({ providers: [], loadError: null });
  assert.deepEqual(view, { kind: 'list', items: [] });
});

test('buildAdminProvidersViewModel surfaces a load error instead of a stale/empty list', () => {
  const view = buildAdminProvidersViewModel({
    providers: null,
    loadError: 'Unable to load providers.',
  });
  assert.deepEqual(view, { kind: 'error', message: 'Unable to load providers.' });
});

test('buildAdminProvidersViewModel lists real provider rows, including active/inactive flags', () => {
  const view = buildAdminProvidersViewModel({
    providers: [providerRow({ id: 1, is_active: true }), providerRow({ id: 2 })],
    loadError: null,
  });
  assert.equal(view.kind, 'list');
  assert.equal(view.items.length, 2);
  assert.equal(view.items[0].is_active, true);
  assert.equal(view.items[1].is_active, false);
});

// --- masked-key rendering ---

test('maskedKeyLabel never renders anything but the last-four representation', () => {
  assert.equal(maskedKeyLabel(providerRow({ api_key_last_four: '9k2p' })), '••••9k2p');
});

// --- add-form submit payload (key write-only) ---

test('buildCreateProviderPayload always includes the api_key field (required on create)', () => {
  const payload = buildCreateProviderPayload({
    providerName: 'claude',
    modelId: 'claude-sonnet-4-20250514',
    apiKey: 'sk-ant-real-secret-value',
  });
  assert.deepEqual(payload, {
    provider_name: 'claude',
    model_id: 'claude-sonnet-4-20250514',
    api_key: 'sk-ant-real-secret-value',
  });
});

test('buildUpdateProviderPayload omits api_key entirely when the field is left blank (write-only, never resubmits a stale/empty key)', () => {
  const payload = buildUpdateProviderPayload({
    modelId: 'claude-sonnet-4-20250514',
    apiKey: '',
  });
  assert.deepEqual(payload, { model_id: 'claude-sonnet-4-20250514' });
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'api_key'), false);
});

test('buildUpdateProviderPayload includes api_key only when the admin explicitly typed a new one', () => {
  const payload = buildUpdateProviderPayload({
    modelId: 'claude-sonnet-4-20250514',
    apiKey: 'sk-ant-new-secret-value',
  });
  assert.deepEqual(payload, {
    model_id: 'claude-sonnet-4-20250514',
    api_key: 'sk-ant-new-secret-value',
  });
});

// --- activate payload / route building ---

test('buildProviderPath encodes the provider id into the update route', () => {
  assert.equal(buildProviderPath(42), '/api/v1/admin/llm-providers/42');
});

test('buildActivatePath encodes the provider id into the activate route', () => {
  assert.equal(buildActivatePath(42), '/api/v1/admin/llm-providers/42/activate');
});

// --- session-scoped secret prompt gating requests ---

test('resolveAdminSecretForRequest reuses an already-cached secret without prompting again', () => {
  const secret = resolveAdminSecretForRequest('already-entered-secret', () => {
    throw new Error('promptFn must not be called when a secret is already cached');
  });
  assert.equal(secret, 'already-entered-secret');
});

test('resolveAdminSecretForRequest prompts exactly once per session when no secret is cached yet', () => {
  let promptCalls = 0;
  const secret = resolveAdminSecretForRequest(null, () => {
    promptCalls += 1;
    return 'freshly-entered-secret';
  });
  assert.equal(secret, 'freshly-entered-secret');
  assert.equal(promptCalls, 1);
});

test('resolveAdminSecretForRequest trims whitespace from a freshly-entered secret', () => {
  const secret = resolveAdminSecretForRequest(null, () => '  padded-secret  ');
  assert.equal(secret, 'padded-secret');
});

test('resolveAdminSecretForRequest returns null (never a request) when the admin cancels the prompt', () => {
  const secret = resolveAdminSecretForRequest(null, () => null);
  assert.equal(secret, null);
});

test('resolveAdminSecretForRequest treats a blank/whitespace-only entry as a cancellation, not an empty secret', () => {
  const secret = resolveAdminSecretForRequest(null, () => '   ');
  assert.equal(secret, null);
});

test('canSendAdminRequest gates requests on a real, non-blank secret', () => {
  assert.equal(canSendAdminRequest(null), false);
  assert.equal(canSendAdminRequest(''), false);
  assert.equal(canSendAdminRequest('   '), false);
  assert.equal(canSendAdminRequest('a-real-secret'), true);
});

// --- 401/403 UI states (TRIANGULATE) ---

test('extractAdminErrorMessage surfaces a clear, specific message on 401 (no secret sent)', () => {
  const message = extractAdminErrorMessage({ status: 401, error: { message: 'nope' } });
  assert.match(message, /admin secret is required/i);
});

test('extractAdminErrorMessage surfaces a clear, specific message on 403 (wrong secret)', () => {
  const message = extractAdminErrorMessage({ status: 403, error: { message: 'nope' } });
  assert.match(message, /rejected|not valid/i);
});

test('extractAdminErrorMessage falls back to the server message for other errors, never a silent failure', () => {
  const message = extractAdminErrorMessage({
    status: 422,
    error: { message: 'provider_name must be one of: claude, deepseek, groq.' },
  });
  assert.equal(message, 'provider_name must be one of: claude, deepseek, groq.');
});

test('extractAdminErrorMessage has a generic-but-non-silent fallback for unrecognized error shapes', () => {
  const message = extractAdminErrorMessage(new Error('network down'));
  assert.equal(message, 'network down');
});

test('isAdminAuthError classifies 401/403 as auth errors requiring the secret to be re-entered', () => {
  assert.equal(isAdminAuthError({ status: 401 }), true);
  assert.equal(isAdminAuthError({ status: 403 }), true);
  assert.equal(isAdminAuthError({ status: 422 }), false);
  assert.equal(isAdminAuthError({ status: 500 }), false);
});
