import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withClient } from "./migrate.mjs";

/** apps/api/src/db/review-repository.mjs -> repo root is 4 levels up. */
export const DEFAULT_CORPUS_DIR = fileURLToPath(
	new URL("../../../../data/academic-rules", import.meta.url),
);

export const DEFAULT_SOURCE_TYPE_BY_FILE = {
	"tesis_guia_trabajo_gt.txt": "gt_guide",
	"plantilla_sugerida_trabajo_graduacion.txt": "gt_guide",
	// thesis-normative-governance design.md D1/D4: this file is the library
	// Reglamento (verified: contains "REGLAMENTO DE TESIS", "Artículo 8°:
	// RESPONSABILIDAD" verbatim), not a rubric. A fresh DB now seeds the
	// correct type directly; `0006_normative_governance.sql`'s UPDATE only
	// matters for a pre-existing DB that already seeded the old `'rubric'`
	// type before this migration ran.
	"lineamientos_ingenieria_sistemas.txt": "reglamento_tesis",
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

const ACTIVE_REVIEW_RUN_STATUSES = new Set([
	"queued",
	"extracting",
	"segmenting",
	"validating",
	"rag_reviewing",
	"reporting",
	"failed",
	"cancelled",
]);
const ALLOWED_REVIEW_PRIORITIES = new Set(["low", "normal", "urgent"]);

function toPublicReviewRunId(value) {
	const id = toId(value);
	return id == null ? null : `review_run_${id}`;
}

function toPublicBoardCardId(value) {
	return `board_${toId(value)}`;
}

function toIdFromPublicBoardCardId(value) {
	const match = String(value).match(/^board_(\d+)$/);
	if (!match) throw new Error(`Invalid review-board card id: ${value}`);
	return Number(match[1]);
}

function metadataValue(metadata, key, fallback) {
	return metadata && typeof metadata === "object" && metadata[key]
		? String(metadata[key])
		: fallback;
}

function splitNormativeSegments(sourceText) {
	return sourceText
		.split(/\n\s*\n+/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function hashText(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function embeddingModel(embeddingProvider) {
	return (
		embeddingProvider?.model ?? embeddingProvider?.modelId ?? "embedding-1536"
	);
}

function toVectorLiteral(vector) {
	if (!Array.isArray(vector) || vector.length !== 1536) {
		throw new Error(
			"Embedding provider must return a 1536-dimensional vector.",
		);
	}
	return `[${vector
		.map((value) => {
			if (!Number.isFinite(value)) {
				throw new Error("Embedding vector values must be finite numbers.");
			}
			return Number(value);
		})
		.join(",")}]`;
}

function projectBoardState({ approvalState, reviewRunStatus }) {
	if (approvalState === "approved") return "approved";
	if (!reviewRunStatus) return "pending";
	if (reviewRunStatus === "completed") return "reviewed";
	return ACTIVE_REVIEW_RUN_STATUSES.has(reviewRunStatus)
		? "in_review"
		: "pending";
}

function attentionText({ reviewRunStatus, errorSummary }) {
	if (reviewRunStatus === "failed") {
		return `Review run failed${errorSummary ? `: ${errorSummary}` : "."}`;
	}
	if (reviewRunStatus === "cancelled") return "Review run was cancelled.";
	return null;
}

async function readReviewBoardCardById(pgClient, boardCardId) {
	const workflowItemId = toIdFromPublicBoardCardId(boardCardId);
	// pi-lens-ignore: ast-grep:no-sql-in-code-js
	const result = await pgClient.query(
		`SELECT wi.id AS workflow_item_id, wi.priority, wi.approval_state,
		        wi.reviewer_name, td.id AS thesis_document_id,
		        td.original_filename, td.metadata AS thesis_metadata,
		        rr.id AS review_run_id,
		        CASE
		          WHEN rr.failed_at IS NOT NULL THEN 'failed'
		          WHEN rr.completed_at IS NOT NULL THEN 'completed'
		          ELSE rr.status
		        END AS review_run_status,
		        rr.error_summary
		 FROM review_workflow_item wi
		 JOIN thesis_document td ON td.id = wi.thesis_document_id
		 LEFT JOIN review_run rr ON rr.id = wi.review_run_id
		 WHERE wi.id = $1`,
		[workflowItemId],
	);
	if (result.rows.length === 0) return null;
	return toReviewBoardCard(result.rows[0]);
}

function toReviewBoardCard(row) {
	const metadata = row.thesis_metadata ?? {};
	const reviewRunStatus = row.review_run_status ?? null;
	const approvalState = row.approval_state ?? "not_approved";
	return {
		id: toPublicBoardCardId(row.workflow_item_id ?? row.thesis_document_id),
		thesis_document_id: `thesis_document_${toId(row.thesis_document_id)}`,
		current_review_run_id: toPublicReviewRunId(row.review_run_id),
		student_name: metadataValue(
			metadata,
			"student_name",
			row.original_filename,
		),
		thesis_title: metadataValue(
			metadata,
			"thesis_title",
			row.original_filename,
		),
		priority: row.priority ?? "normal",
		approval_state: approvalState,
		board_state: projectBoardState({ approvalState, reviewRunStatus }),
		review_run_status: reviewRunStatus,
		reviewer_label: row.reviewer_name ?? null,
		report_ready: reviewRunStatus === "completed",
		attention_text: attentionText({
			reviewRunStatus,
			errorSummary: row.error_summary,
		}),
	};
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
				const corpusFiles = await readdir(corpusDir);
				const files = corpusFiles
					.filter((name) => name.endsWith(".txt"))
					.sort();
				const idByFile = {};
				for (const file of files) {
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					const existing = await pgClient.query(
						"SELECT id FROM normative_source WHERE title = $1",
						[file],
					);
					if (existing.rows.length > 0) {
						idByFile[file] = toId(existing.rows[0].id);
						continue;
					}
					const sourceType = sourceTypeByFile[file] ?? "gt_guide";
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
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

		/**
		 * thesis-normative-governance design.md D4: resolves one real
		 * `normative_source.id` per `source_type` — deterministic even when a
		 * type has several rows (`gt_guide` has two corpus files today):
		 * `DISTINCT ON (source_type)` orders by `precedence` then `id`, so the
		 * lowest-tier, lowest-id row always wins, never an arbitrary one.
		 * Consumed by `live-review-pipeline.mjs`'s `resolveNormativeSourceId`
		 * to widen its cached key space beyond corpus filenames (D4).
		 */
		async getNormativeSourceIdsBySourceType() {
			return run(async (pgClient) => {
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
				const result = await pgClient.query(
					`SELECT DISTINCT ON (source_type) source_type, id
					 FROM normative_source
					 ORDER BY source_type, precedence, id`,
				);
				const idBySourceType = {};
				for (const row of result.rows) {
					idBySourceType[row.source_type] = toId(row.id);
				}
				return idBySourceType;
			});
		},

		async seedNormativeSegments({
			corpusDir = DEFAULT_CORPUS_DIR,
			sourceTypeByFile = DEFAULT_SOURCE_TYPE_BY_FILE,
		} = {}) {
			return run(async (pgClient) => {
				const sourceIds = await this.seedNormativeSources({
					corpusDir,
					sourceTypeByFile,
				});
				const idByFile = {};
				for (const file of Object.keys(sourceIds).sort()) {
					const sourceText = await readFile(`${corpusDir}/${file}`, "utf8");
					const sourceId = sourceIds[file];
					idByFile[file] = [];
					for (const [index, segmentText] of splitNormativeSegments(
						sourceText,
					).entries()) {
						const segmentHash = hashText(segmentText);
						// pi-lens-ignore: ast-grep:no-sql-in-code-js
						const existing = await pgClient.query(
							`SELECT id FROM normative_segment
							 WHERE normative_source_id = $1 AND metadata->>'content_hash' = $2`,
							[sourceId, segmentHash],
						);
						if (existing.rows.length > 0) {
							idByFile[file].push(toId(existing.rows[0].id));
							continue;
						}
						// pi-lens-ignore: ast-grep:no-sql-in-code-js
						const inserted = await pgClient.query(
							`INSERT INTO normative_segment
							   (normative_source_id, segment_text, metadata)
							 VALUES ($1,$2,$3) RETURNING id`,
							[
								sourceId,
								segmentText,
								JSON.stringify({
									segment_index: index,
									content_hash: segmentHash,
								}),
							],
						);
						idByFile[file].push(toId(inserted.rows[0].id));
					}
				}
				return idByFile;
			});
		},

		async seedNormativeEmbeddings({
			corpusDir = DEFAULT_CORPUS_DIR,
			sourceTypeByFile = DEFAULT_SOURCE_TYPE_BY_FILE,
			embeddingProvider,
		} = {}) {
			if (!embeddingProvider || typeof embeddingProvider.embed !== "function") {
				throw new TypeError(
					"seedNormativeEmbeddings requires an embedding provider.",
				);
			}
			await this.seedNormativeSegments({ corpusDir, sourceTypeByFile });
			return run(async (pgClient) => {
				const model = embeddingModel(embeddingProvider);
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
				const segments = await pgClient.query(
					`SELECT id, segment_text FROM normative_segment ORDER BY id`,
				);
				let inserted = 0;
				let existing = 0;
				for (const segment of segments.rows) {
					const segmentId = toId(segment.id);
					const contentHash = hashText(segment.segment_text);
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					const found = await pgClient.query(
						`SELECT id FROM embedding_record
						 WHERE source_class = 'normative_segment'
						   AND source_id = $1
						   AND embedding_model = $2
						   AND content_hash = $3`,
						[segmentId, model, contentHash],
					);
					if (found.rows.length > 0) {
						existing += 1;
						continue;
					}
					const vector = toVectorLiteral(
						await embeddingProvider.embed(segment.segment_text),
					);
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					await pgClient.query(
						`INSERT INTO embedding_record
						   (source_class, source_id, embedding_model, embedding, content_hash)
						 VALUES ('normative_segment',$1,$2,$3::vector,$4)`,
						[segmentId, model, vector, contentHash],
					);
					inserted += 1;
				}
				return { inserted, existing, model };
			});
		},

		async retrieveNormativeContext({
			queryText,
			embeddingProvider,
			limit = 4,
		} = {}) {
			if (!embeddingProvider || typeof embeddingProvider.embed !== "function") {
				throw new TypeError(
					"retrieveNormativeContext requires an embedding provider.",
				);
			}
			const queryVector = toVectorLiteral(
				await embeddingProvider.embed(queryText ?? ""),
			);
			return run(async (pgClient) => {
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
				const result = await pgClient.query(
					`SELECT ns.id AS normative_source_id, ns.title AS source_ref,
					        seg.id AS segment_id, seg.segment_text,
					        1 - (er.embedding <=> $1::vector) AS similarity_score
					 FROM embedding_record er
					 JOIN normative_segment seg
					   ON seg.id = er.source_id AND er.source_class = 'normative_segment'
					 JOIN normative_source ns ON ns.id = seg.normative_source_id
					 WHERE er.embedding_model = $2
					 ORDER BY er.embedding <=> $1::vector, seg.id
					 LIMIT $3`,
					[queryVector, embeddingModel(embeddingProvider), limit],
				);
				return result.rows.map((row) => ({
					normative_source_id: toId(row.normative_source_id),
					source_ref: row.source_ref,
					segment_id: toId(row.segment_id),
					segment_text: row.segment_text,
					similarity_score: Number(row.similarity_score),
				}));
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
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
				await pgClient.query("BEGIN");
				try {
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
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
					const thesisDocumentId = toId(result.rows[0].id);
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					await pgClient.query(
						`INSERT INTO review_workflow_item (thesis_document_id)
						 VALUES ($1)
						 ON CONFLICT (thesis_document_id) DO NOTHING`,
						[thesisDocumentId],
					);
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					await pgClient.query("COMMIT");
					return thesisDocumentId;
				} catch (error) {
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					await pgClient.query("ROLLBACK");
					throw error;
				}
			});
		},

		async insertReviewRun({
			thesisDocumentId,
			pipelineVersion = "pipeline-v1",
			status = "queued",
		}) {
			return run(async (pgClient) => {
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
				await pgClient.query("BEGIN");
				try {
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					const result = await pgClient.query(
						`INSERT INTO review_run (thesis_document_id, status, pipeline_version)
						 VALUES ($1,$2,$3) RETURNING id`,
						[thesisDocumentId, status, pipelineVersion],
					);
					const reviewRunId = toId(result.rows[0].id);
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					await pgClient.query(
						`INSERT INTO review_workflow_item (thesis_document_id, review_run_id)
						 VALUES ($1,$2)
						 ON CONFLICT (thesis_document_id) DO UPDATE
						 SET review_run_id = EXCLUDED.review_run_id, updated_at = now()`,
						[thesisDocumentId, reviewRunId],
					);
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					await pgClient.query("COMMIT");
					return reviewRunId;
				} catch (error) {
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					await pgClient.query("ROLLBACK");
					throw error;
				}
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
				metadata,
			} = {},
		) {
			return run(async (pgClient) => {
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
				await pgClient.query(
					`UPDATE review_run SET
					   status = COALESCE($2, status),
					   started_at = COALESCE($3, started_at),
					   completed_at = COALESCE($4, completed_at),
					   failed_at = COALESCE($5, failed_at),
					   error_summary = COALESCE($6, error_summary),
					   llm_provider_name = COALESCE($7, llm_provider_name),
					   llm_model_id = COALESCE($8, llm_model_id),
					   metadata = COALESCE($9, metadata)
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
						metadata ? JSON.stringify(metadata) : null,
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
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
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

		async listReviewBoardCards() {
			return run(async (pgClient) => {
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
				const result = await pgClient.query(
					`SELECT wi.id AS workflow_item_id, wi.priority, wi.approval_state,
					        wi.reviewer_name, td.id AS thesis_document_id,
					        td.original_filename, td.metadata AS thesis_metadata,
					        rr.id AS review_run_id,
					        CASE
					          WHEN rr.failed_at IS NOT NULL THEN 'failed'
					          WHEN rr.completed_at IS NOT NULL THEN 'completed'
					          ELSE rr.status
					        END AS review_run_status,
					        rr.error_summary
					 FROM thesis_document td
					 LEFT JOIN review_workflow_item wi ON wi.thesis_document_id = td.id
					 LEFT JOIN LATERAL (
					   SELECT * FROM review_run latest
					   WHERE latest.thesis_document_id = td.id
					   ORDER BY latest.created_at DESC, latest.id DESC
					   LIMIT 1
					 ) latest_rr ON true
					 LEFT JOIN review_run rr ON rr.id = COALESCE(wi.review_run_id, latest_rr.id)
					 ORDER BY td.created_at DESC, td.id DESC`,
				);
				return result.rows.map(toReviewBoardCard);
			});
		},

		async updateReviewBoardPriority(boardCardId, priority) {
			if (!ALLOWED_REVIEW_PRIORITIES.has(priority)) {
				throw new Error(`Invalid review-board priority: ${priority}`);
			}
			return run(async (pgClient) => {
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
				await pgClient.query(
					`UPDATE review_workflow_item
					 SET priority = $2, updated_at = now()
					 WHERE id = $1`,
					[toIdFromPublicBoardCardId(boardCardId), priority],
				);
				return readReviewBoardCardById(pgClient, boardCardId);
			});
		},

		async approveReviewBoardCard(boardCardId, { reviewerName = null } = {}) {
			return run(async (pgClient) => {
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
				await pgClient.query(
					`UPDATE review_workflow_item
					 SET approval_state = 'approved', reviewer_name = COALESCE($2, reviewer_name), updated_at = now()
					 WHERE id = $1`,
					[toIdFromPublicBoardCardId(boardCardId), reviewerName],
				);
				return readReviewBoardCardById(pgClient, boardCardId);
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
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
				await pgClient.query("BEGIN");
				try {
					const ids = [];
					const idByPageNumber = {};
					for (const page of pages) {
						const pageNumber = page.pageNumber ?? null;
						// pi-lens-ignore: ast-grep:no-sql-in-code-js
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
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					await pgClient.query("COMMIT");
					return { ids, idByPageNumber };
				} catch (error) {
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
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
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
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
						// pi-lens-ignore: ast-grep:no-sql-in-code-js
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
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					await pgClient.query("COMMIT");
					return { ids, idByIndex };
				} catch (error) {
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
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
		 *
		 * `finding.ruleId`/`finding.metadata` (design.md D3) are optional —
		 * `ruleId` defaults to `null` (only deterministic-rule findings set it,
		 * e.g. `"filler_words.lexicon_match"`) and `metadata` defaults to `{}`,
		 * both columns already existing on `finding` since `0001_schema_baseline.sql`.
		 */
		async persistFinding({
			reviewRunId,
			normativeSourceId,
			finding,
			evidence,
		}) {
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
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
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
						// pi-lens-ignore: ast-grep:no-sql-in-code-js
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

					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					const findingInserted = await pgClient.query(
						`INSERT INTO finding
						   (review_run_id, finding_type, severity, confidence, title, explanation, recommendation, producer_type, producer_id, rule_id, normative_source_id, metadata, status)
						 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'valid') RETURNING id`,
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
							finding.ruleId ?? null,
							normativeSourceId ?? null,
							JSON.stringify(finding.metadata ?? {}),
						],
					);
					const findingId = toId(findingInserted.rows[0].id);

					for (const evidenceId of evidenceIds) {
						// pi-lens-ignore: ast-grep:no-sql-in-code-js
						await pgClient.query(
							`INSERT INTO finding_evidence (finding_id, evidence_snippet_id, role)
							 VALUES ($1,$2,'primary')`,
							[findingId, evidenceId],
						);
					}

					// pi-lens-ignore: ast-grep:no-sql-in-code-js
					await pgClient.query("COMMIT");
					return { findingId, evidenceIds };
				} catch (error) {
					// pi-lens-ignore: ast-grep:no-sql-in-code-js
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
				// pi-lens-ignore: ast-grep:no-sql-in-code-js
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
