import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ThesisApiClient } from '../thesis-api-client';
import { validateSelectedFiles } from './upload-validation';

type UploadStatus = 'idle' | 'submitting' | 'error';

/**
 * Upload page: lets the user select exactly one PDF/DOCX thesis file,
 * submits it to `POST /api/v1/thesis-documents`, then triggers a review run
 * and navigates to the results page for that run.
 */
@Component({
  selector: 'app-upload-page',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Upload thesis document</h1>
    <form (submit)="onSubmit($event)">
      <input
        type="file"
        accept=".pdf,.docx"
        (change)="onFilesSelected($event)"
        [disabled]="status() === 'submitting'"
      />
      <button type="submit" [disabled]="status() === 'submitting'">
        @if (status() === 'submitting') {
          Uploading...
        } @else {
          Upload
        }
      </button>
    </form>

    @if (errorMessage(); as message) {
      <p role="alert">{{ message }}</p>
    }
  `,
})
export class UploadPage {
  private readonly api = inject(ThesisApiClient);
  private readonly router = inject(Router);

  protected readonly fileControl = new FormControl<File[]>([], {
    nonNullable: true,
  });
  protected readonly status = signal<UploadStatus>('idle');
  protected readonly errorMessage = signal<string | null>(null);

  protected onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    this.fileControl.setValue(files);
  }

  protected onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const files = this.fileControl.value;
    const validation = validateSelectedFiles(files);
    if (!validation.ok) {
      this.status.set('error');
      this.errorMessage.set(validation.message);
      return;
    }

    this.status.set('submitting');
    this.errorMessage.set(null);
    this.api.uploadThesisDocument(files[0]).subscribe({
      next: (document) => this.startReviewRun(document.id),
      error: (err: unknown) => this.fail(err),
    });
  }

  private startReviewRun(documentId: string): void {
    this.api.triggerReviewRun(documentId).subscribe({
      next: (run) => {
        this.status.set('idle');
        void this.router.navigate(['/runs', run.id]);
      },
      error: (err: unknown) => this.fail(err),
    });
  }

  private fail(err: unknown): void {
    this.status.set('error');
    this.errorMessage.set(extractErrorMessage(err));
  }
}

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'error' in err) {
    const httpError = err as { error?: { message?: string } };
    if (httpError.error?.message) return httpError.error.message;
  }
  return 'Upload failed. Please try again.';
}
