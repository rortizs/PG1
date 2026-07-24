import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSelectedFiles } from '../src/app/upload/upload-validation.ts';

test('valid PDF selection passes validation', () => {
  const result = validateSelectedFiles([{ type: 'application/pdf' }]);
  assert.deepEqual(result, { ok: true });
});

test('valid DOCX selection passes validation', () => {
  const result = validateSelectedFiles([
    {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  ]);
  assert.deepEqual(result, { ok: true });
});

test('unsupported file type is rejected', () => {
  const result = validateSelectedFiles([{ type: 'text/plain' }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported_type');
});

test('zero files is rejected', () => {
  const result = validateSelectedFiles([]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'file_count');
});

test('multiple files is rejected', () => {
  const result = validateSelectedFiles([
    { type: 'application/pdf' },
    { type: 'application/pdf' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'file_count');
});
