import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import {
  FindingsListResponse,
  ReviewRunResponse,
  ThesisApiClient,
} from '../thesis-api-client';

/**
 * Results page: shows a review run's live status from the API. Finding
 * rendering is wired to the real `GET .../findings` endpoint, but until PR C
 * persists real findings this legitimately renders the "no findings yet"
 * empty state — see design.md decision on synchronous CAG persistence.
 */
@Component({
  selector: 'app-results-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Review run status</h1>

    @if (loadError(); as message) {
      <p role="alert">{{ message }}</p>
    } @else if (run(); as currentRun) {
      <p>Status: {{ currentRun.status }}</p>
      <p>Stage: {{ currentRun.progress_stage }}</p>

      @if (findings()?.items?.length) {
        <ul>
          @for (finding of findings()!.items; track finding.id) {
            <li>
              <h2>{{ finding.title }}</h2>
              <p>{{ finding.explanation }}</p>
              <blockquote>{{ finding.evidence_text }}</blockquote>
            </li>
          }
        </ul>
      } @else {
        <p>No findings yet.</p>
      }
    } @else {
      <p>Loading review run...</p>
    }
  `,
})
export class ResultsPage {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ThesisApiClient);

  protected readonly runId = signal<string>(
    this.route.snapshot.paramMap.get('runId') ?? '',
  );
  protected readonly run = signal<ReviewRunResponse | null>(null);
  protected readonly findings = signal<FindingsListResponse | null>(null);
  protected readonly loadError = signal<string | null>(null);

  constructor() {
    this.loadRun();
  }

  private loadRun(): void {
    const id = this.runId();
    if (!id) {
      this.loadError.set('No review run id was provided.');
      return;
    }

    this.api.getReviewRun(id).subscribe({
      next: (run) => this.run.set(run),
      error: () => this.loadError.set('Unable to load review run status.'),
    });

    this.api.getReviewRunFindings(id).subscribe({
      next: (findings) => this.findings.set(findings),
      error: () => this.findings.set(null),
    });
  }
}
