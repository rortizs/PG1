import type {
  FindingSummary,
  FindingsListResponse,
  ReviewRunResponse,
} from '../thesis-api-client';

/**
 * Pure, framework-free view-model logic for the results page — mirrors
 * `upload-validation.ts`'s pattern (Work Unit 4): the decision of "what to
 * render" is a plain function, directly unit-testable with `node:test`
 * without an Angular TestBed/jsdom harness. `results-page.ts` consumes this
 * to decide both its template branch and whether to keep polling.
 */

const TERMINAL_REVIEW_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalReviewRunStatus(status: string): boolean {
  return TERMINAL_REVIEW_RUN_STATUSES.has(status);
}

export type ResultsViewModel =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'in_progress'; status: string; stage: string }
  | { kind: 'failed'; status: string; errorSummary: string | null }
  | { kind: 'findings'; status: string; items: FindingSummary[] }
  | { kind: 'no_findings'; status: string };

export function buildResultsViewModel({
  run,
  findings,
  loadError,
}: {
  run: ReviewRunResponse | null;
  findings: FindingsListResponse | null;
  loadError: string | null;
}): ResultsViewModel {
  if (loadError) return { kind: 'error', message: loadError };
  if (!run) return { kind: 'loading' };

  if (!isTerminalReviewRunStatus(run.status)) {
    return { kind: 'in_progress', status: run.status, stage: run.progress_stage };
  }

  if (run.status === 'failed') {
    return { kind: 'failed', status: run.status, errorSummary: run.error_summary };
  }

  const items = findings?.items ?? [];
  if (items.length > 0) {
    return { kind: 'findings', status: run.status, items };
  }
  return { kind: 'no_findings', status: run.status };
}
