import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('web app boots a real standalone Angular application with upload and results routes', async () => {
  const mainSource = await readFile(
    new URL('../src/main.ts', import.meta.url),
    'utf8',
  );
  assert.match(mainSource, /bootstrapApplication/);
  assert.match(mainSource, /App/);

  const configSource = await readFile(
    new URL('../src/app/app.config.ts', import.meta.url),
    'utf8',
  );
  assert.match(configSource, /provideRouter/);
  assert.match(configSource, /provideHttpClient/);

  const routesSource = await readFile(
    new URL('../src/app/app.routes.ts', import.meta.url),
    'utf8',
  );
  assert.match(routesSource, /upload/);
  assert.match(routesSource, /runs\/:runId/);
  assert.match(routesSource, /admin\/llm-providers/);
});

test('upload and results feature components exist as real standalone, OnPush Angular components', async () => {
  const uploadSource = await readFile(
    new URL('../src/app/upload/upload-page.ts', import.meta.url),
    'utf8',
  );
  assert.match(uploadSource, /class UploadPage/);
  assert.match(uploadSource, /ChangeDetectionStrategy\.OnPush/);
  assert.match(uploadSource, /ReactiveFormsModule/);

  const resultsSource = await readFile(
    new URL('../src/app/results/results-page.ts', import.meta.url),
    'utf8',
  );
  assert.match(resultsSource, /class ResultsPage/);
  assert.match(resultsSource, /ChangeDetectionStrategy\.OnPush/);
});

test('admin providers feature exists as a real standalone, OnPush Angular component and never persists the secret to localStorage', async () => {
  const pageSource = await readFile(
    new URL('../src/app/admin/admin-providers-page.ts', import.meta.url),
    'utf8',
  );
  assert.match(pageSource, /class AdminProvidersPage/);
  assert.match(pageSource, /ChangeDetectionStrategy\.OnPush/);
  assert.match(pageSource, /ReactiveFormsModule/);

  const secretStoreSource = await readFile(
    new URL('../src/app/admin/admin-secret-store.ts', import.meta.url),
    'utf8',
  );
  assert.match(secretStoreSource, /class AdminSecretStore/);
  // The doc comment legitimately explains why localStorage is NOT used —
  // assert no actual storage-API *usage*, not the absence of the word.
  assert.doesNotMatch(secretStoreSource, /localStorage\s*[.[]/);
  assert.doesNotMatch(secretStoreSource, /sessionStorage\s*[.[]/);

  const apiClientSource = await readFile(
    new URL('../src/app/admin/admin-api-client.ts', import.meta.url),
    'utf8',
  );
  assert.match(apiClientSource, /class AdminApiClient/);
  assert.match(apiClientSource, /x-admin-secret/);
});
