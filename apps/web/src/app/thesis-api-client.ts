import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

export interface ThesisDocumentResponse {
  id: string;
  type: string;
  status: string;
  upload_status?: string;
  review_eligible: boolean;
  original_filename?: string;
  content_type?: string;
  links: { self: string };
}

export interface ReviewRunResponse {
  id: string;
  type: string;
  thesis_document_id: string | null;
  status: string;
  progress_stage: string;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error_summary: string | null;
  summary: {
    pages: number;
    sections: number;
    findings: number;
    reports: number;
  };
  /**
   * llm-provider-admin Work Unit 8: which provider (name + model id) handled
   * this run — `null`/`null` for runs with no recorded provenance (e.g. a
   * pre-existing run from before this change), never an error.
   */
  llm_provider_name: string | null;
  llm_model_id: string | null;
}

export interface FindingSummary {
  id: string;
  title: string;
  explanation: string;
  evidence_text: string;
  severity?: string;
}

export interface FindingsListResponse {
  review_run_id: string;
  items: FindingSummary[];
  total: number;
  page: number;
  page_size: number;
  filters: Record<string, string>;
}

/**
 * Thin typed HTTP client for the PG1 API's thesis-document and review-run
 * routes. Reused by both the upload page and the results page.
 */
@Injectable({ providedIn: 'root' })
export class ThesisApiClient {
  private readonly http = inject(HttpClient);

  uploadThesisDocument(file: File): Observable<ThesisDocumentResponse> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.http.post<ThesisDocumentResponse>(
      '/api/v1/thesis-documents',
      formData,
    );
  }

  triggerReviewRun(documentId: string): Observable<ReviewRunResponse> {
    return this.http.post<ReviewRunResponse>(
      `/api/v1/thesis-documents/${encodeURIComponent(documentId)}/review-runs`,
      {},
    );
  }

  getReviewRun(runId: string): Observable<ReviewRunResponse> {
    return this.http.get<ReviewRunResponse>(
      `/api/v1/review-runs/${encodeURIComponent(runId)}`,
    );
  }

  getReviewRunFindings(runId: string): Observable<FindingsListResponse> {
    return this.http.get<FindingsListResponse>(
      `/api/v1/review-runs/${encodeURIComponent(runId)}/findings`,
    );
  }
}
