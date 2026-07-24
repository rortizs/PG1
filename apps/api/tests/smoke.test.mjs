import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapApi } from '../src/main.ts';

test('api boots a real NestJS HTTP server bound to localhost and serves the thesis-documents route', async () => {
  const app = await bootstrapApi();
  await app.listen(0, '127.0.0.1');

  try {
    const baseUrl = await app.getUrl();
    const response = await fetch(
      `${baseUrl}/api/v1/thesis-documents?page=1&page_size=5`,
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.items));
    assert.equal(body.page, 1);
    assert.equal(body.page_size, 5);
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
