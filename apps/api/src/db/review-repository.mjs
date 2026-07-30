import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withClient } from "./migrate.mjs";

/** apps/api/src/db/review-repository.mjs -> repo root is 4 levels up. */
export const DEFAULT_CORPUS_DIR = fileURLToPath(
	new URL("../../../../data/academic-rules", import.meta.url),
);

export const DEFAULT_SOURCE_TYPE_BY_FILE = {
	"tesis_guia_trabajo_gt.txt": "gt_guide",
	"plantilla_sugerida_trabajo_graduacion.txt": "gt_guide",
	"lineamientos_ingenieria_sistemas.txt": "rubric",
	"ejemplo_para_guia.txt": "example_observation",
};

/** Thrown instead of ever writing a `finding` row with zero evidence. */
export class EvidenceRequiredError extends Error {}

/**
 * `pg` returns BIGINT columns as strings (JS numbers cannot safely represent
 * the full int8 range). Every id in this schema is `GENERATED ALWAYS AS
 * IDENTITY`, so in practice values stay far below `Number.MAX_SAFE_INTEGER`
 * — coerce to a plain number so callers get ordinary JS integers.
 */
function toId(value) {
	return value === null || value === undefined ? value : Number(value);
}

/**
 * Real `pg`-backed writes for the CAG review flow:
 * thesis_document -> review_run -> evidence_snippet -> finding -> finding_evidence,
 * plus idempotent `normative_source` seeding for the static corpus files.
 *
 * Accepts either a caller-owned `client` (reused across calls, left open) or
 * a `connectionString` (each call opens/closes its own client via the shared
 * `withClient` helper from `migrate.mjs`) — same shape as `migrate.mjs`.
 */
export function createReviewRepository({ client, connectionString } = {}) {
	const run = (fn) => withClient({ client, connectionString }, fn);

	return {
		async seedNormativeSources({
			corpusDir = DEFAULT_CORPUS_DIR,
			sourceTypeByFile = DEFAULT_SOURCE_TYPE_BY_FILE,
		} = {}) {
			return run(async (pgClient) => {
				const files = (await readdir(corpusDir))
					.filter((name) => name.endsWith(".txt"))
					.sort();
				const idByFile = {};
				for (const file of files) {
					const existing = await pgClient.query(
						"SELECT id FROM normative_source WHERE title = $1",
						[file],
					);
					if (existing.rows.length > 0) {
						idByFile[file] = toId(existing.rows[0].id);
						continue;
					}
					const sourceType = sourceTypeByFile[file] ?? "gt_guide";
					const inserted = await pgClient.query(
						`INSERT INTO normative_source (source_type, title, is_approved)
						 VALUES ($1, $2, true) RETURNING id`,
						[sourceType, file],
					);
					idByFile[file] = toId(inserted.rows[0].id);
				}
				return idByFile;
			});
		},

		async insertThesisDocument({
			originalFilename,
			contentType,
			fileSizeBytes,
			storageKey,
			sha256,
			uploadStatus = "uploaded",
			uploadedByUserId,
			metadata = {},
		}) {
			return run(async (pgClient) => {
				const result = await pgClient.query(
					`INSERT INTO thesis_document
					   (original_filename, content_type, file_size_bytes, storage_key, sha256, upload_status, uploaded_by_user_id, metadata)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
					[
						originalFilename,
						contentType,
						fileSizeBytes,
						storageKey,
						sha256,
						uploadStatus,
						uploadedByUserId,
						JSON.stringify(metadata),
					],
				);
				return toId(result.rows[0].id);
			});
		},

		async insertReviewRun({
			thesisDocumentId,
			pipelineVersion = "pipeline-v1",
			status = "queued",
		}) {
			return run(async (pgClient) => {
				const result = await pgClient.query(
					`INSERT INTO review_run (thesis_document_id, status, pipeline_version)
					 VALUES ($1,$2,$3) RETURNING id`,
					[thesisDocumentId, status, pipelineVersion],
				);
				return toId(result.rows[0].id);
			});
		},

		async updateReviewRunStatus(
			reviewRunId,
			{
				status,
				startedAt,
				completedAt,
				failedAt,
				errorSummary,
				llmProviderName,
				llmModelId,
			} = {},
		) {
			return run(async (pgClient) => {
				await pgClient.query(
					`UPDATE review_run SET
					   status = COALESCE($2, status),
					   started_at = COALESCE($3, started_at),
					   completed_at = COALESCE($4, completed_at),
					   failed_at = COALESCE($5, failed_at),
					   error_summary = COALESCE($6, error_summary),
					   llm_provider_name = COALESCE($7, llm_provider_name),
					   llm_model_id = COALESCE($8, llm_model_id)
					 WHERE id = $1`,
					[
						reviewRunId,
						status ?? null,
						startedAt ?? null,
						completedAt ?? null,
						failedAt ?? null,
						errorSummary ?? null,
						llmProviderName ?? null,
						llmModelId ?? null,
					],
				);
			});
		},

		/**
		 * llm-provider-admin Work Unit 8: reads back which provider (name +
		 * model id) handled a review run — `null`/`null` for runs where
		 * provenance was never set (e.g. pre-existing runs from before this
		 * change), never an error. Consumed by `api-contract.mjs`'s live GET
		 * `/review-runs/{id}` path.
		 */
		async getReviewRunProvenance(reviewRunId) {
			return run(async (pgClient) => {
				const result = await pgClient.query(
					"SELECT llm_provider_name, llm_model_id FROM review_run WHERE id = $1",
					[reviewRunId],
				);
				if (result.rows.length === 0) return null;
				return {
					llmProviderName: result.rows[0].llm_provider_name,
					llmModelId: result.rows[0].llm_model_id,
				};
			});
		},

		/**
		 * Persists every extracted page as a real `document_page` row inside a
		 * single transaction, in the given order (design.md D3). `pages[]`
		 * items are `{ pageNumber, text }`; `extractionMethod`/
		 * `provenanceConfidence`/`pageMetadata` are call-level defaults applied
		 * uniformly to every page (a single extraction run uses one method).
		 * Returns both the raw ordered `ids` and an `idByPageNumber` lookup map
		 * used to wire real `document_page_id` foreign keys into findings.
		 */
		async insertDocumentPages({
			reviewRunId,
			thesisDocumentId,
			pages,
			extractionMethod = "pdf_text",
			provenanceConfidence = null,
			pageMetadata = {},
		}) {
			return run(async (pgClient) => {
				await pgClient.query("BEGIN");
				try {
					const ids = [];
					const idByPageNumber = {};
					for (const page of pages) {
						const pageNumber = page.pageNumber ?? null;
						const inserted = await pgClient.query(
							`INSERT INTO document_page
							   (thesis_document_id, review_run_id, page_number, text_content, extraction_method, provenance_confidence, is_page_number_uncertain, metadata)
							 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
							[
								thesisDocumentId,
								reviewRunId,
								pageNumber,
								page.text ?? "",
								extractionMethod,
								provenanceConfidence,
								Boolean(page.isPageNumberUncertain ?? pageNumber == null),
								JSON.stringify(pageMetadata),
							],
						);
						const id = toId(inserted.rows[0].id);
						ids.push(id);
						if (pageNumber != null) idByPageNumber[pageNumber] = id;
					}
					await pgClient.query("COMMIT");
					return { ids, idByPageNumber };
				} catch (error) {
					await pgClient.query("ROLLBACK");
					throw error;
				}
			});
		},

		/**
		 * Persists every detected section as a real `document_section` row
		 * inside a single transaction. `sections[]` MUST be supplied in
		 * document order — a parent heading always precedes its children
		 * (design.md D2's level-stack invariant) — so each section's
		 * `parentIndex` can be resolved against the `idByIndex` map built so
		 * far. A `parentIndex` that has not already been inserted (an
		 * out-of-order violation) throws rather than silently orphaning the
		 * section (never writes a row with a dangling/guessed parent).
		 */
		async insertDocumentSections({ reviewRunId, sections }) {
			return run(async (pgClient) => {
				await pgClient.query("BEGIN");
				try {
					const ids = [];
					const idByIndex = {};
					for (const section of sections) {
						let parentSectionId = null;
						if (section.parentIndex != null) {
							if (!(section.parentIndex in idByIndex)) {
								throw new Error(
									`insertDocumentSections: parentIndex ${section.parentIndex} for section index ${section.index} was not already inserted — sections must be supplied in document order (parent before child).`,
								);
							}
							parentSectionId = idByIndex[section.parentIndex];
						}
						const inserted = await pgClient.query(
							`INSERT INTO document_section
							   (review_run_id, parent_section_id, section_type, title, normalized_title, start_page_number, end_page_number, start_offset, end_offset, is_location_uncertain, metadata)
							 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
							[
								reviewRunId,
								parentSectionId,
								section.sectionType,
								section.title ?? null,
								section.normalizedTitle ?? null,
								section.startPageNumber ?? null,
								section.endPageNumber ?? null,
								section.startOffset ?? null,
								section.endOffset ?? null,
								Boolean(section.isLocationUncertain),
								JSON.stringify(section.metadata ?? {}),
							],
						);
						const id = toId(inserted.rows[0].id);
						ids.push(id);
						idByIndex[section.index] = id;
					}
					await pgClient.query("COMMIT");
					return { ids, idByIndex };
				} catch (error) {
					await pgClient.query("ROLLBACK");
					throw error;
				}
			});
		},

		/**
		 * Persists exactly one finding with its evidence, evidence-first, inside
		 * a single transaction. Never writes a `finding` row when `evidence` is
		 * empty or any snippet lacks real text/location provenance — throws
		 * `EvidenceRequiredError` instead (mirrors the existing evidence-snippet
		 * DB CHECK constraint with a friendlier, app-level error type).
		 */
		async persistFinding({ reviewRunId, normativeSourceId, finding, evidence }) {
			if (!Array.isArray(evidence) || evidence.length === 0) {
				throw new EvidenceRequiredError(
					"Cannot persist a finding with zero evidence rows.",
				);
			}
			for (const snippet of evidence) {
				if (!snippet.evidenceText || !snippet.evidenceText.trim()) {
					throw new EvidenceRequiredError(
						"Evidence snippet text must not be empty.",
					);
				}
			}

			return run(async (pgClient) => {
				await pgClient.query("BEGIN");
				try {
					const evidenceIds = [];
					for (const snippet of evidence) {
						const hasLocation =
							snippet.pageNumber != null ||
							snippet.documentPageId != null ||
							snippet.documentSectionId != null ||
							Boolean(snippet.isPageUncertain) ||
							Boolean(snippet.isSectionUncertain);
						if (!hasLocation) {
							throw new EvidenceRequiredError(
								"Evidence snippet must carry page/section provenance or an explicit uncertainty flag.",
							);
						}
						const inserted = await pgClient.query(
							`INSERT INTO evidence_snippet
							   (review_run_id, document_page_id, document_section_id, evidence_text, page_number, chapter_or_section_title, is_page_uncertain, is_section_uncertain)
							 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
							[
								reviewRunId,
								snippet.documentPageId ?? null,
								snippet.documentSectionId ?? null,
								snippet.evidenceText,
								snippet.pageNumber ?? null,
								snippet.sectionTitle ?? null,
								Boolean(snippet.isPageUncertain),
								Boolean(snippet.isSectionUncertain),
							],
						);
						evidenceIds.push(toId(inserted.rows[0].id));
					}

					const findingInserted = await pgClient.query(
						`INSERT INTO finding
						   (review_run_id, finding_type, severity, confidence, title, explanation, recommendation, producer_type, producer_id, normative_source_id, status)
						 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'valid') RETURNING id`,
						[
							reviewRunId,
							finding.findingType ?? "rag_review",
							finding.severity ?? "medium",
							finding.confidence ?? null,
							finding.title,
							finding.explanation,
							finding.recommendation ?? null,
							finding.producerType ?? "controlled_rag",
							finding.producerId,
							normativeSourceId ?? null,
						],
					);
					const findingId = toId(findingInserted.rows[0].id);

					for (const evidenceId of evidenceIds) {
						await pgClient.query(
							`INSERT INTO finding_evidence (finding_id, evidence_snippet_id, role)
							 VALUES ($1,$2,'primary')`,
							[findingId, evidenceId],
						);
					}

					await pgClient.query("COMMIT");
					return { findingId, evidenceIds };
				} catch (error) {
					await pgClient.query("ROLLBACK");
					throw error;
				}
			});
		},

		/**
		 * Reads back every persisted finding (+ its primary evidence) for a
		 * review run, ordered by id. Used by the live HTTP GET
		 * `/review-runs/{id}/findings` path — never returns fabricated data,
		 * only rows genuinely written by `persistFinding`.
		 */
		async listFindingsForReviewRun(reviewRunId) {
			return run(async (pgClient) => {
				const result = await pgClient.query(
					`SELECT f.id AS finding_id, f.finding_type, f.severity, f.confidence,
					        f.title, f.explanation, f.recommendation,
					        es.evidence_text, es.page_number, es.chapter_or_section_title
					 FROM finding f
					 JOIN finding_evidence fe ON fe.finding_id = f.id AND fe.role = 'primary'
					 JOIN evidence_snippet es ON es.id = fe.evidence_snippet_id
					 WHERE f.review_run_id = $1
					 ORDER BY f.id`,
					[reviewRunId],
				);
				return result.rows.map((row) => ({
					id: `finding_${toId(row.finding_id)}`,
					finding_type: row.finding_type,
					severity: row.severity,
					confidence: row.confidence,
					title: row.title,
					explanation: row.explanation,
					recommendation: row.recommendation,
					evidence_text: row.evidence_text,
					page_number: toId(row.page_number),
					section_title: row.chapter_or_section_title,
				}));
			});
		},
	};
}
