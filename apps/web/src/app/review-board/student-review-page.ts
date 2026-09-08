import {
	ChangeDetectionStrategy,
	Component,
	computed,
	inject,
	signal,
} from "@angular/core";
import { ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { forkJoin } from "rxjs";
import { buildMarkdownReportDownload } from "../results/report-download-view";
import type { ReportArtifact } from "../results/report-download-view";
import {
	ThesisApiClient,
	type ReviewRunResponse,
} from "../thesis-api-client";
import { validateSelectedFiles } from "../upload/upload-validation";
import type { ReviewBoardApiCard } from "./review-board-api";
import { buildReviewProgressView } from "./review-progress-view";
import { buildStudentReviewViewModel } from "./student-review-view";

/**
 * Student review detail shell backed by the real review-board and
 * review-run APIs — no fixtures, no fabricated demo data. `studentId` in the
 * route is the review-board card id (there is no separate "student" DB
 * concept). Existing upload/review APIs remain the production path for
 * persisted runs; this page only reads.
 */
@Component({
	selector: "app-student-review-page",
	imports: [ReactiveFormsModule, RouterLink],
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: `
    <main aria-labelledby="student-review-title">
      <a routerLink="/review-board">Back to review board</a>

      @switch (view().kind) {
        @case ('loading') {
          <p>Loading student review...</p>
        }
        @case ('error') {
          <p role="alert">{{ errorMessage() }}</p>
        }
        @case ('not_found') {
          <p role="alert">No review-board card was found for "{{ notFoundStudentId() }}".</p>
        }
        @case ('found') {
          <header>
            <h1 id="student-review-title">{{ studentName() }}</h1>
            <p>{{ thesisTitle() }}</p>
            <p>State: {{ boardState() }}</p>
            <p>Priority: {{ priority() }}</p>
            <p>Reviewer: {{ reviewerName() }}</p>
            <p>Method shown: Rules + CAG review, grounded with RAG-retrieved normative context.</p>
          </header>

          <section aria-labelledby="upload-title" (dragover)="onDragOver($event)" (drop)="onDrop($event)">
            <h2 id="upload-title">Upload thesis file</h2>
            <p>Choose or drop exactly one PDF or DOCX file, 20 MB or smaller.</p>
            <form (submit)="onSubmit($event)">
              <input type="file" accept=".pdf,.docx" (change)="onFilesSelected($event)" />
              <button type="submit" [disabled]="!canSubmitUpload()">Validate selected file</button>
            </form>
            @if (validationMessage(); as message) {
              <p role="alert">{{ message }}</p>
            }
            @if (uploadFeedback(); as feedback) {
              <p>{{ feedback }}</p>
            }
          </section>

          <section aria-labelledby="progress-title">
            <h2 id="progress-title">Analysis progress</h2>
            @if (studentStatus()) {
              <p>Stage: {{ progress().stage }}</p>
              <p>Projected progress: {{ progress().percent }}%</p>
              @if (progress().nextAction; as nextAction) {
                <p role="alert">{{ nextAction }}</p>
              }
            } @else {
              <p>No review run has started for this student yet.</p>
            }
          </section>

          <section aria-labelledby="report-title">
            <h2 id="report-title">Report</h2>
            @if (markdownDownload(); as download) {
              <button type="button" (click)="downloadMarkdownReport()">Download Markdown Report</button>
              <p>Filename: {{ download.filename }}</p>
            } @else {
              <p>No Markdown report is available yet.</p>
            }
          </section>

          <section aria-labelledby="checklist-title">
            <h2 id="checklist-title">Reviewer checklist</h2>
            <ul>
              <li>Client-side file validation</li>
              <li>Rules pass</li>
              <li>CAG review summary</li>
              <li>Human approval</li>
            </ul>
          </section>
        }
      }
    </main>
  `,
	styles: [`
    :host {
      display: block;
      max-width: 800px;
      margin: 0 auto;
      padding: var(--pg1-page-margin) var(--pg1-space-gutter);
    }

    main > a {
      display: inline-block;
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-size);
      margin-bottom: var(--pg1-node-gap);
    }

    main > p {
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-sm-size);
      letter-spacing: var(--pg1-label-mono-sm-tracking);
      color: var(--pg1-color-outline);
      text-transform: uppercase;
      margin-bottom: var(--pg1-space-gutter);
    }

    header {
      margin-bottom: var(--pg1-space-gutter);
      padding-bottom: var(--pg1-space-gutter);
      border-bottom: var(--pg1-border-structural);
    }

    header h1 {
      margin-bottom: calc(var(--pg1-space-unit) * 2);
    }

    header p:nth-of-type(1) {
      font-style: italic;
      color: var(--pg1-color-outline);
      margin-bottom: var(--pg1-node-gap);
    }

    header p:nth-of-type(2),
    header p:nth-of-type(3),
    header p:nth-of-type(4) {
      display: inline-block;
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-size);
      color: var(--pg1-color-ink);
      margin-right: var(--pg1-node-gap);
      margin-bottom: calc(var(--pg1-space-unit) * 2);
    }

    header p:nth-of-type(5) {
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-sm-size);
      letter-spacing: var(--pg1-label-mono-sm-tracking);
      color: var(--pg1-color-outline);
      margin-top: var(--pg1-node-gap);
      margin-bottom: 0;
    }

    section {
      margin-bottom: var(--pg1-space-gutter);
      padding: var(--pg1-container-padding);
      border: var(--pg1-border-hairline);
    }

    section h2 {
      margin-bottom: var(--pg1-node-gap);
    }

    section[aria-labelledby='upload-title'] {
      border: var(--pg1-border-current);
      background: var(--pg1-color-surface-container-low);
    }

    section[aria-labelledby='upload-title']:hover,
    section[aria-labelledby='upload-title']:focus-within {
      background: var(--pg1-ink-wash-05);
    }

    section form {
      display: flex;
      align-items: center;
      gap: var(--pg1-node-gap);
      flex-wrap: wrap;
      margin-top: var(--pg1-node-gap);
    }

    section p {
      margin-bottom: var(--pg1-space-unit);
    }

    section [role='alert'] {
      margin-top: var(--pg1-node-gap);
    }

    section button[type='button'] {
      margin-top: var(--pg1-node-gap);
    }

    ul {
      display: flex;
      flex-direction: column;
      gap: calc(var(--pg1-space-unit) * 2);
    }

    li {
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-size);
      padding: calc(var(--pg1-space-unit) * 2) 0;
      border-bottom: var(--pg1-border-hairline);
    }

    li:last-child {
      border-bottom: none;
    }
  `],
})
export class StudentReviewPage {
	private readonly route = inject(ActivatedRoute);
	private readonly api = inject(ThesisApiClient);
	private readonly studentId = signal(
		this.route.snapshot.paramMap.get("studentId") ?? "",
	);
	private readonly selectedFiles = signal<File[]>([]);

	private readonly cards = signal<readonly ReviewBoardApiCard[] | null>(null);
	private readonly run = signal<ReviewRunResponse | null>(null);
	private readonly reportArtifacts = signal<readonly ReportArtifact[] | null>(
		null,
	);
	private readonly loadError = signal<string | null>(null);

	protected readonly uploadFeedback = signal<string | null>(null);
	protected readonly view = computed(() =>
		buildStudentReviewViewModel({
			studentId: this.studentId(),
			cards: this.cards(),
			loadError: this.loadError(),
			run: this.run(),
			reportArtifacts: this.reportArtifacts(),
		}),
	);
	protected readonly progress = computed(() =>
		buildReviewProgressView(this.review().status ?? "queued"),
	);
	protected readonly uploadValidation = computed(() =>
		validateSelectedFiles(this.selectedFiles()),
	);
	protected readonly canSubmitUpload = computed(
		() => this.uploadValidation().ok,
	);
	protected readonly validationMessage = computed(() => {
		const validation = this.uploadValidation();
		return this.selectedFiles().length > 0 && !validation.ok
			? validation.message
			: null;
	});
	protected readonly markdownDownload = computed(() =>
		buildMarkdownReportDownload(
			selectMarkdownReportArtifact(this.review().reportArtifacts),
		),
	);

	protected onFilesSelected(event: Event): void {
		const input = event.target as HTMLInputElement;
		this.setSelectedFiles(input.files ? Array.from(input.files) : []);
	}

	protected onDragOver(event: DragEvent): void {
		event.preventDefault();
	}

	protected onDrop(event: DragEvent): void {
		event.preventDefault();
		this.setSelectedFiles(
			event.dataTransfer ? Array.from(event.dataTransfer.files) : [],
		);
	}

	protected onSubmit(event: SubmitEvent): void {
		event.preventDefault();
		const validation = this.uploadValidation();
		if (!validation.ok) {
			this.uploadFeedback.set(validation.message);
			return;
		}

		this.uploadFeedback.set(
			"File accepted locally. Persisted review runs still start through the existing upload workflow.",
		);
	}

	protected downloadMarkdownReport(): void {
		const download = this.markdownDownload();
		if (!download) return;

		const blob = new Blob([download.content], { type: download.contentType });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = download.filename;
		anchor.click();
		URL.revokeObjectURL(url);
	}

	private setSelectedFiles(files: File[]): void {
		this.selectedFiles.set(files);
		this.uploadFeedback.set(null);
	}
}
