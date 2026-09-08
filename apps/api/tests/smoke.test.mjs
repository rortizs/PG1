import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapApi } from '../src/main.ts';

// reviewer-authentication PR3a: `SessionGuard` now gates every route except
// the two public auth routes (design.md D6). Without a `DATABASE_URL`-backed
// database in this DB-free smoke test, an unauthenticated real HTTP request
// still proves the app boots, the route is registered, and the guard fires
// correctly end to end — a `404` here would mean the route was never wired;
// a `200` would mean the guard never ran. `401` is exactly the expected,
// deliberate outcome now.
test('api boots a real NestJS HTTP server bound to localhost and requires a session for the thesis-documents route', async () => {
  const app = await bootstrapApi();
  await app.listen(0, '127.0.0.1');

  try {
    const baseUrl = await app.getUrl();
    const response = await fetch(
      `${baseUrl}/api/v1/thesis-documents?page=1&page_size=5`,
    );

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'unauthorized');
  } finally {
    await app.close();
  }
});

test('api server only binds to 127.0.0.1, not all interfaces', async () => {
  const app = await bootstrapApi();
  await app.listen(0, '127.0.0.1');

  try {
    const baseUrl = await app.getUrl();
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await app.close();
  }
});
