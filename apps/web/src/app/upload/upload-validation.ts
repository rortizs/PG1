/**
 * Client-side pre-validation mirroring the API's upload contract
 * (`upload-service.mjs`). This never replaces server-side validation — the
 * API remains the source of truth — it only gives the user immediate
 * feedback before a request is sent.
 */
export const ACCEPTED_THESIS_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export interface SelectableFile {
  readonly type: string;
}

export type UploadValidationResult =
  | { ok: true }
  | { ok: false; code: 'file_count'; message: string }
  | { ok: false; code: 'unsupported_type'; message: string };

export function validateSelectedFiles(
  files: readonly SelectableFile[],
): UploadValidationResult {
  if (files.length !== 1) {
    return {
      ok: false,
      code: 'file_count',
      message: 'Select exactly one PDF or DOCX file.',
    };
  }

  const [file] = files;
  if (!ACCEPTED_THESIS_CONTENT_TYPES.has(file.type)) {
    return {
      ok: false,
      code: 'unsupported_type',
      message: 'Only PDF and DOCX files are supported.',
    };
  }

  return { ok: true };
}
