import {
	ChangeDetectionStrategy,
	Component,
	computed,
	inject,
	signal,
} from "@angular/core";
import { ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, RouterLink } from "@angular/router";
import {
	type ReportArtifact,
	buildMarkdownReportDownload,
	selectMarkdownReportArtifact,
} from "../results/report-download-view";
import { validateSelectedFiles } from "../upload/upload-validation";
import type { ReviewPriority } from "./review-board-view";
import { buildReviewProgressView } from "./review-progress-view";

interface DemoFallbackStudentReview {
	readonly id: string;
	readonly studentName: string;
	readonly thesisTitle: string;
	readonly boardState: string;
	readonly priority: ReviewPriority;
	readonly reviewerName: string;
	readonly status: string | null;
	readonly summary: string | null;
	readonly reportArtifacts: readonly ReportArtifact[];
	readonly checklist: readonly string[];
}

const DEMO_FALLBACK_STUDENT_REVIEWS: Record<string, DemoFallbackStudentReview> =
	{
		"ana-martinez": {
			id: "ana-martinez",
			studentName: "Ana Martínez",
			thesisTitle: "Inclusive assessment practices in first-year programming",
			boardState: "In Review",
			priority: "Urgent",
			reviewerName: "Dr. Rivera",
			status: "rag_reviewing",
			summary: null,
			reportArtifacts: [],
			checklist: [
				"Client-side file validation",
				"Rules pass",
				"CAG review summary",
				"Human approval",
			],
		},
		"mila-perez": {
			id: "mila-perez",
			studentName: "Mila Pérez",
			thesisTitle: "Feedback cycles in academic writing studios",
			boardState: "Reviewed",
			priority: "Low",
			reviewerName: "Prof. Chen",
			status: "completed",
			summary:
				"Automated checks completed. A human reviewer still controls approval.",
			reportArtifacts: [
				{
					id: "report-md-1",
					kind: "markdown",
					filename: "mila-perez-review.md",
					content_type: "text/markdown",
					content:
						"# Thesis Review\n\nRules + CAG review completed. Human approval remains required.\n",
				},
			],
			checklist: [
				"Client-side file validation",
				"Rules pass",
				"CAG review summary",
				"Human approval",
			],
		},
	};

const DEFAULT_DEMO_FALLBACK_STUDENT_REVIEW: DemoFallbackStudentReview = {
	id: "sample-student",
	studentName: "Sample student",
	thesisTitle: "Pending thesis upload",
	boardState: "Pending",
	priority: "Normal",
	reviewerName: "Unassigned",
	status: null,
	summary: null,
	reportArtifacts: [],
	checklist: [
		"Client-side file validation",
		"Rules pass",
		"CAG review summary",
		"Human approval",
	],
};

/**
 * Student review detail shell using clearly named demo fallback data until a
 * dedicated detail API is available. Existing upload/review APIs remain the
 * production path for persisted runs.
 */
@Component({
	selector: "app-student-review-page",
	imports: [ReactiveFormsModule, RouterLink],
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: `
    <main aria-labelledby="student-review-title">
      <a routerLink="/review-board">Back to review board</a>
      <p>Demo fallback student review projection until a dedicated detail API is available.</p>

      <header>
        <h1 id="student-review-title">{{ review().studentName }}</h1>
        <p>{{ review().thesisTitle }}</p>
        <p>State: {{ review().boardState }}</p>
        <p>Priority: {{ review().priority }}</p>
        <p>Reviewer: {{ review().reviewerName }}</p>
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
        @if (review().status) {
          <p>Stage: {{ progress().stage }}</p>
          <p>Projected progress: {{ progress().percent }}%</p>
          @if (progress().nextAction; as nextAction) {
            <p role="alert">{{ nextAction }}</p>
          }
        } @else {
          <p>No review run has started for this sample student.</p>
        }
      </section>

      <section aria-labelledby="report-title">
        <h2 id="report-title">Report</h2>
        @if (review().summary) {
          <p>{{ review().summary }}</p>
        } @else {
          <p>No Markdown report is available yet.</p>
        }
        @if (markdownDownload(); as download) {
          <button type="button" (click)="downloadMarkdownReport()">Download Markdown Report</button>
          <p>Filename: {{ download.filename }}</p>
        }
      </section>

      <section aria-labelledby="checklist-title">
        <h2 id="checklist-title">Reviewer checklist</h2>
        <ul>
          @for (item of review().checklist; track item) {
            <li>{{ item }}</li>
          }
        </ul>
      </section>
    </main>
  `,
})
export class StudentReviewPage {
	private readonly route = inject(ActivatedRoute);
	private readonly studentId = signal(
		this.route.snapshot.paramMap.get("studentId") ?? "sample-student",
	);
	private readonly selectedFiles = signal<File[]>([]);

	protected readonly uploadFeedback = signal<string | null>(null);
	protected readonly review = computed(
		() =>
			DEMO_FALLBACK_STUDENT_REVIEWS[this.studentId()] ??
			DEFAULT_DEMO_FALLBACK_STUDENT_REVIEW,
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
