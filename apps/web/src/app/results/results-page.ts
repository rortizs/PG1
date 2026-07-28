import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import {
  FindingsListResponse,
  ReviewRunResponse,
  ThesisApiClient,
} from '../thesis-api-client';
import { buildResultsViewModel, isTerminalReviewRunStatus } from './results-view';

const POLL_INTERVAL_MS = 3000;

/**
 * Results page: shows a review run's LIVE status and, once the run reaches
 * a terminal state, its real persisted finding(s) — reading exclusively
 * from the real API (no fixtures, no fabricated data). While the run is
 * still processing, it polls `GET .../review-runs/{id}` every
 * `POLL_INTERVAL_MS` until a terminal status (`completed`/`failed`/
 * `cancelled`) is reached.
 */
@Component({
  selector: 'app-results-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Review run status</h1>

    @switch (view().kind) {
      @case ('loading') {
        <p>Loading review run...</p>
      }
      @case ('error') {
        <p role="alert">{{ errorMessage() }}</p>
      }
      @case ('in_progress') {
        <p>Status: {{ statusLabel() }}</p>
        <p>Stage: {{ stageLabel() }}</p>
      }
      @case ('failed') {
        <p>Status: failed</p>
        <p role="alert">{{ failureSummary() }}</p>
      }
      @case ('findings') {
        <p>Status: completed</p>
        <p>Reviewed by: {{ providerLabel() }}</p>
        <ul>
          @for (finding of findingItems(); track finding.id) {
            <li>
              <h2>{{ finding.title }}</h2>
              <p>{{ finding.explanation }}</p>
              <blockquote>{{ finding.evidence_text }}</blockquote>
            </li>
          }
        </ul>
      }
      @case ('no_findings') {
        <p>Status: completed</p>
        <p>Reviewed by: {{ providerLabel() }}</p>
        <p>No findings.</p>
      }
    }
  `,
})
export class ResultsPage {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ThesisApiClient);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly runId = signal<string>(
    this.route.snapshot.paramMap.get('runId') ?? '',
  );
  private readonly run = signal<ReviewRunResponse | null>(null);
  private readonly findings = signal<FindingsListResponse | null>(null);
  private readonly loadError = signal<string | null>(null);

  protected readonly view = computed(() =>
    buildResultsViewModel({
      run: this.run(),
      findings: this.findings(),
      loadError: this.loadError(),
    }),
  );

  protected readonly statusLabel = computed(() => {
    const view = this.view();
    return view.kind === 'in_progress' ? view.status : '';
  });
  protected readonly stageLabel = computed(() => {
    const view = this.view();
    return view.kind === 'in_progress' ? view.stage : '';
  });
  protected readonly failureSummary = computed(() => {
    const view = this.view();
    return view.kind === 'failed'
      ? (view.errorSummary ?? 'The review run failed.')
      : '';
  });
  protected readonly findingItems = computed(() => {
    const view = this.view();
    return view.kind === 'findings' ? view.items : [];
  });
  protected readonly providerLabel = computed(() => {
    const view = this.view();
    return view.kind === 'findings' || view.kind === 'no_findings' ? view.providerLabel : '';
  });
  protected readonly errorMessage = computed(() => {
    const view = this.view();
    return view.kind === 'error' ? view.message : '';
  });

  private pollTimeoutId: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.pollTimeoutId !== undefined) clearTimeout(this.pollTimeoutId);
    });
    this.loadRun();
  }

  private loadRun(): void {
    const id = this.runId();
    if (!id) {
      this.loadError.set('No review run id was provided.');
      return;
    }

    this.api.getReviewRun(id).subscribe({
      next: (run) => {
        this.run.set(run);
        this.loadError.set(null);
        this.scheduleNextPollIfNeeded(run);
      },
      error: () => this.loadError.set('Unable to load review run status.'),
    });

    this.api.getReviewRunFindings(id).subscribe({
      next: (findings) => this.findings.set(findings),
      error: () => this.findings.set(null),
    });
  }

  private scheduleNextPollIfNeeded(run: ReviewRunResponse): void {
    if (isTerminalReviewRunStatus(run.status)) return;
    this.pollTimeoutId = setTimeout(() => this.loadRun(), POLL_INTERVAL_MS);
  }
}
