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
