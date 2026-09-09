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
  assert.match(configSource, /withInterceptors/);
  assert.match(configSource, /sessionInterceptor/);

  const routesSource = await readFile(
    new URL('../src/app/app.routes.ts', import.meta.url),
    'utf8',
  );
  assert.match(routesSource, /upload/);
  assert.match(routesSource, /runs\/:runId/);
  assert.match(routesSource, /admin\/llm-providers/);
  assert.match(routesSource, /login/);
});

test('protected routes are guarded by requireSession; the login route itself is not gated', async () => {
  const routesSource = await readFile(
    new URL('../src/app/app.routes.ts', import.meta.url),
    'utf8',
  );

  const loginRouteMatch = routesSource.match(/\{\s*path:\s*["']login["'][^}]*\}/s);
  assert.ok(loginRouteMatch, 'login route not found');
  assert.match(loginRouteMatch[0], /component:\s*LoginPage/);
  assert.doesNotMatch(loginRouteMatch[0], /canActivate/);

  const protectedPaths = [
    'upload',
    'runs/:runId',
    'review-board',
    'students/:studentId/review',
    'admin/llm-providers',
  ];
  for (const path of protectedPaths) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const routeMatch = routesSource.match(
      new RegExp(`\\{[^}]*path:\\s*["']${escaped}["'][^}]*\\}`, 's'),
    );
    assert.ok(routeMatch, `route "${path}" not found`);
    assert.match(routeMatch[0], /canActivate:\s*\[requireSession\]/);
  }
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

test('admin providers feature exists as a real standalone, OnPush Angular component and no longer manages its own shared secret', async () => {
  const pageSource = await readFile(
    new URL('../src/app/admin/admin-providers-page.ts', import.meta.url),
    'utf8',
  );
  assert.match(pageSource, /class AdminProvidersPage/);
  assert.match(pageSource, /ChangeDetectionStrategy\.OnPush/);
  assert.match(pageSource, /ReactiveFormsModule/);
  // The old admin-secret shared-secret disclaimer copy is retired now that
  // reviewer sessions are real authentication (reviewer-authentication D11).
  assert.doesNotMatch(pageSource, /NOT real authentication/);

  const apiClientSource = await readFile(
    new URL('../src/app/admin/admin-api-client.ts', import.meta.url),
    'utf8',
  );
  assert.match(apiClientSource, /class AdminApiClient/);
  // The x-admin-secret header mechanism is retired (D11) — the session
  // interceptor now supplies `Authorization` for every request, admin
  // included.
  assert.doesNotMatch(apiClientSource, /x-admin-secret/);
});

test('the reviewer session mechanism is in-memory only, never persisted to localStorage/sessionStorage', async () => {
  const sessionStoreSource = await readFile(
    new URL('../src/app/auth/session-store.ts', import.meta.url),
    'utf8',
  );
  assert.match(sessionStoreSource, /class SessionStore/);
  assert.doesNotMatch(sessionStoreSource, /localStorage\s*[.[]/);
  assert.doesNotMatch(sessionStoreSource, /sessionStorage\s*[.[]/);
});
