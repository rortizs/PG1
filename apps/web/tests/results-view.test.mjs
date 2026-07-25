import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResultsViewModel,
  isTerminalReviewRunStatus,
} from '../src/app/results/results-view.ts';

function run(overrides = {}) {
  return {
    id: 'run_1',
    type: 'review_run',
    thesis_document_id: 'doc_1',
    status: 'queued',
    progress_stage: 'queued',
    created_at: null,
    started_at: null,
    completed_at: null,
    failed_at: null,
    error_summary: null,
    summary: { pages: 0, sections: 0, findings: 0, reports: 0 },
    ...overrides,
  };
}

function findingsResponse(items = []) {
  return {
    review_run_id: 'run_1',
    items,
    total: items.length,
    page: 1,
    page_size: 50,
    filters: {},
  };
}

test('isTerminalReviewRunStatus classifies each review-run status', () => {
  assert.equal(isTerminalReviewRunStatus('queued'), false);
  assert.equal(isTerminalReviewRunStatus('extracting'), false);
  assert.equal(isTerminalReviewRunStatus('rag_reviewing'), false);
  assert.equal(isTerminalReviewRunStatus('completed'), true);
  assert.equal(isTerminalReviewRunStatus('failed'), true);
  assert.equal(isTerminalReviewRunStatus('cancelled'), true);
});

test('buildResultsViewModel shows loading state before the run has loaded', () => {
  const view = buildResultsViewModel({ run: null, findings: null, loadError: null });
  assert.deepEqual(view, { kind: 'loading' });
});

test('buildResultsViewModel surfaces a load error', () => {
  const view = buildResultsViewModel({
    run: null,
    findings: null,
    loadError: 'Unable to load review run status.',
  });
  assert.deepEqual(view, {
    kind: 'error',
    message: 'Unable to load review run status.',
  });
});

test('buildResultsViewModel shows an in-progress status while non-terminal', () => {
  const view = buildResultsViewModel({
    run: run({ status: 'rag_reviewing', progress_stage: 'rag_reviewing' }),
    findings: null,
    loadError: null,
  });
  assert.deepEqual(view, {
    kind: 'in_progress',
    status: 'rag_reviewing',
    stage: 'rag_reviewing',
  });
});

test('buildResultsViewModel shows the persisted finding once completed', () => {
  const view = buildResultsViewModel({
    run: run({ status: 'completed', progress_stage: 'completed' }),
    findings: findingsResponse([
      {
        id: 'finding_1',
        title: 'Missing APA citation',
        explanation: 'The excerpt paraphrases without citing.',
        evidence_text: 'Studies show thesis quality improves with review.',
        severity: 'medium',
      },
    ]),
    loadError: null,
  });
  assert.equal(view.kind, 'findings');
  assert.equal(view.status, 'completed');
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].title, 'Missing APA citation');
});

test('buildResultsViewModel shows a "no findings" state for a completed run with zero findings', () => {
  const view = buildResultsViewModel({
    run: run({ status: 'completed', progress_stage: 'completed' }),
    findings: findingsResponse([]),
    loadError: null,
  });
  assert.deepEqual(view, { kind: 'no_findings', status: 'completed' });
});

test('buildResultsViewModel treats a completed run with findings still loading as "no findings yet", not an error', () => {
  const view = buildResultsViewModel({
    run: run({ status: 'completed', progress_stage: 'completed' }),
    findings: null,
    loadError: null,
  });
  assert.deepEqual(view, { kind: 'no_findings', status: 'completed' });
});

test('buildResultsViewModel shows a failed run with its error summary, not findings', () => {
  const view = buildResultsViewModel({
    run: run({
      status: 'failed',
      progress_stage: 'failed',
      error_summary: 'review failed: Claude API timeout',
    }),
    findings: findingsResponse([]),
    loadError: null,
  });
  assert.equal(view.kind, 'failed');
  assert.equal(view.errorSummary, 'review failed: Claude API timeout');
});
