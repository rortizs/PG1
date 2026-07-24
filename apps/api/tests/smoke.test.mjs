import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = new URL('../src/main.ts', import.meta.url);

test('api scaffold exposes a NestJS-compatible bootstrap entrypoint', async () => {
  const content = await readFile(source, 'utf8');

  assert.match(content, /bootstrapApi/);
  assert.match(content, /NestJS-compatible/);
});
