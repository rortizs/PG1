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
  | { kind: 'findings'; status: string; items: FindingSummary[]; providerLabel: string }
  | { kind: 'no_findings'; status: string; providerLabel: string };

/**
 * llm-provider-admin Work Unit 8: a completed run's provenance is rendered
 * as one human-readable label. Missing provenance (a pre-existing run from
 * before this change, or any other reason the columns are NULL) renders a
 * graceful "Unknown provider" state — never a blank string, never an error.
 */
export function formatProviderLabel({
  providerName,
  modelId,
}: {
  providerName: string | null;
  modelId: string | null;
}): string {
  if (!providerName) return 'Unknown provider';
  if (!modelId) return `${providerName} (unknown model)`;
  return `${providerName} (${modelId})`;
}

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

  const providerLabel = formatProviderLabel({
    providerName: run.llm_provider_name,
    modelId: run.llm_model_id,
  });
  const items = findings?.items ?? [];
  if (items.length > 0) {
    return { kind: 'findings', status: run.status, items, providerLabel };
  }
  return { kind: 'no_findings', status: run.status, providerLabel };
}
