import { createFilesystemObjectStorage } from "./storage/object-storage.mjs";
import { createReviewRepository } from "./db/review-repository.mjs";
import { createReviewPipeline } from "./jobs/review-orchestrator.mjs";

/**
 * Composition root for the LIVE (real Postgres + real worker) review
 * pipeline, wired into `api-contract.mjs`'s HTTP routes.
 *
 * Real vs. stub routing rationale (see apply-progress.md "Live HTTP Wiring"
 * for the full writeup): `contract.test.mjs`'s
 * "POST .../review-runs returns lifecycle-backed 202 response" test asserts
 * `status: "queued"` for a FABRICATED document id that was never uploaded.
 * Driving every document id through this real, synchronous pipeline would
 * break that assertion, because any synchronous processing — success or
 * failure — flips the run's status away from "queued" before the response
 * is read.
 *
 * The fix: only documents that were genuinely persisted through
 * `registerUploadedDocument` (i.e. a real `POST /api/v1/thesis-documents`
 * upload, with `DATABASE_URL` configured) are routed through this real
 * pipeline. Any other document id — including fabricated/never-uploaded
 * ones — keeps using the existing in-memory stub `review-run-lifecycle.mjs`
 * singleton in `api-contract.mjs`, unchanged. This requires zero changes to
 * `contract.test.mjs`'s protected assertion.
 */

const DEFAULT_WORKER_BASE_URL = "http://localhost:8000";
const WORKER_EXTRACT_TIMEOUT_MS = 30_000;

// Real bytes on disk (design decision #11), shared across requests within
// this process — fixes the pre-existing bug where a fresh in-memory storage
// instance was created (and immediately discarded) on every upload request.
const documentStorage = createFilesystemObjectStorage();

// In-process registry: external thesis-document id (e.g. `doc_1a2b3c...`)
// -> the bytes/metadata needed to (re)drive extraction, plus the internal
// Postgres `thesis_document.id` once persisted. A document only ever enters
// this registry after a REAL, successful DB insert — see
// `registerUploadedDocument` below — which is exactly what makes an id
// "known" for live-pipeline routing purposes.
const uploadedDocuments = new Map();

let cachedRepository = null;
let cachedPipeline = null;
let cachedNormativeSourceIds = null;

function databaseUrl() {
	return process.env.DATABASE_URL || null;
}

function getRepository() {
	const connectionString = databaseUrl();
	if (!connectionString) return null;
	if (!cachedRepository) {
		cachedRepository = createReviewRepository({ connectionString });
	}
	return cachedRepository;
}

async function resolveNormativeSourceId(repository, ref) {
	if (!cachedNormativeSourceIds) {
		cachedNormativeSourceIds = await repository.seedNormativeSources();
	}
	return cachedNormativeSourceIds[ref] ?? null;
}

async function extractViaWorker({ thesisDocumentId }) {
	const entry = uploadedDocuments.get(thesisDocumentId);
	if (!entry) {
		throw new Error(
			`No stored bytes found for thesis document: ${thesisDocumentId}`,
		);
	}
	const stored = await documentStorage.getObject(entry.storageKey);
	const workerBaseUrl = process.env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;
	const formData = new FormData();
	formData.append(
		"file",
		new Blob([stored.content], {
			type: stored.contentType || entry.contentType || "application/octet-stream",
		}),
		entry.filename || "upload",
	);
	const response = await fetch(`${workerBaseUrl}/internal/extract`, {
		method: "POST",
		body: formData,
		signal: AbortSignal.timeout(WORKER_EXTRACT_TIMEOUT_MS),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Worker /internal/extract failed with status ${response.status}: ${detail}`,
		);
	}
	return response.json();
}

/**
 * Lazily builds (and caches) the real pipeline instance. Returns `null`
 * when `DATABASE_URL` is not configured — the process stays in the
 * pre-existing offline/stub-only mode in that case (matches every currently
 * passing test that runs without Docker Postgres).
 */
export function getLivePipeline() {
	const repository = getRepository();
	if (!repository) return null;
	if (!cachedPipeline) {
		const pipeline = createReviewPipeline({
			repository,
			resolveThesisDocumentDbId: async (documentId) => {
				const entry = uploadedDocuments.get(documentId);
				if (!entry?.dbId) {
					throw new Error(
						`Unknown or unpersisted thesis document: ${documentId}`,
					);
				}
				return entry.dbId;
			},
			extractThesisText: extractViaWorker,
			resolveNormativeSourceId: (ref) => resolveNormativeSourceId(repository, ref),
		});
		cachedPipeline = {
			lifecycle: pipeline.lifecycle,
			repository,
			getReviewRunDbId: pipeline.getReviewRunDbId,
		};
	}
	return cachedPipeline;
}

export function isKnownUploadedDocument(documentId) {
	return uploadedDocuments.has(documentId);
}

export function getDocumentStorage() {
	return documentStorage;
}

/**
 * Called after a successful (`201`) upload. If `DATABASE_URL` is
 * configured, persists a real `thesis_document` row (spec: "the API MUST
 * persist the accepted upload as a real row in thesis_document") and
 * registers the document as eligible for the live pipeline. If
 * `DATABASE_URL` is not set, this is a deliberate no-op — uploads keep
 * behaving exactly as before this pass, and every review-run trigger for
 * that document falls back to the existing in-memory stub lifecycle.
 *
 * `uploaderUserId` defaults to `0` (no auth in this MVP; the schema's
 * `uploaded_by_user_id` column is `NOT NULL`) — `0` is a documented
 * placeholder for "no authenticated uploader", not a real user id.
 */
// Postgres connection-level error codes: these mean the database is
// genuinely unreachable, matching spec's "Postgres unreachable -> 5xx"
// scenario. Any OTHER database error (e.g. schema not migrated yet) means
// Postgres IS reachable but persistence still failed — the uploaded bytes
// are already safely stored, so that case degrades to a logged warning
// instead of turning an otherwise-successful upload into a request failure.
const CONNECTION_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"ETIMEDOUT",
	"08000",
	"08003",
	"08006",
	"57P03",
]);

function isConnectionError(error) {
	return CONNECTION_ERROR_CODES.has(error?.code);
}

export async function registerUploadedDocument({
	documentId,
	sha256,
	storageKey,
	contentType,
	filename,
	fileSizeBytes,
	uploaderUserId,
}) {
	const repository = getRepository();
	if (!repository) return { persisted: false };

	try {
		const dbId = await repository.insertThesisDocument({
			originalFilename: filename,
			contentType,
			fileSizeBytes,
			storageKey,
			sha256,
			uploadedByUserId: uploaderUserId ?? 0,
		});
		uploadedDocuments.set(documentId, {
			dbId,
			sha256,
			storageKey,
			contentType,
			filename,
		});
		return { persisted: true, dbId };
	} catch (error) {
		if (isConnectionError(error)) throw error;
		// eslint-disable-next-line no-console
		console.error(
			`registerUploadedDocument: could not persist thesis_document for ${documentId} (Postgres reachable, but the write failed): ${error.message}`,
		);
		return { persisted: false, error: error.message };
	}
}

/** Test-only escape hatch: clears every cached singleton/registry entry. */
export function _resetLiveReviewPipelineForTests() {
	uploadedDocuments.clear();
	cachedRepository = null;
	cachedPipeline = null;
	cachedNormativeSourceIds = null;
}
