/**
 * Minimal structural HTTP request/response shapes used by controllers when
 * delegating to `handleApiRequest`. Kept intentionally narrow (rather than
 * importing full Express types) so controllers stay dependency-light while
 * remaining strictly typed (no `any`).
 */
export interface HttpRequest {
  method: string;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
  params: Record<string, string>;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}
