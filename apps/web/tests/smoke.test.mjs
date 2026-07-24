import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = new URL('../src/app/app.ts', import.meta.url);

test('web scaffold follows Angular feature-oriented admin shell convention', async () => {
  const content = await readFile(source, 'utf8');

  assert.match(content, /Pg1AdminApp/);
  assert.match(content, /features\/review-dashboard/);
});
