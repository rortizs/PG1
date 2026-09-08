import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createAuthenticatedSession } from "./support/reviewer-session-fixture.mjs";

/**
 * reviewer-authentication PR4, Work Unit 4 (design.md D8): the last three
 * call sites that still trusted a client-supplied identity now read it from
 * the session `checkSession()` already resolved earlier in the same
 * request:
 *
 *   - `POST /api/v1/review-board/cards/{card_id}/approval` — a forged
 *     `reviewerName` body field must never reach `review_workflow_item`;
 *     only the authenticated reviewer's own name and id may.
 *   - `POST /api/v1/thesis-documents` — `uploaded_by_user_id` is sourced
 *     from the session, never the request body, and is never `0`.
 *   - `live-review-pipeline.mjs`'s `registerUploadedDocument` throws loudly
 *     on a null/undefined `uploaderUserId` instead of silently defaulting
 *     to `0` (the `?? 0` fallback that made unattributed rows possible).
 *
 * Before this unit exists: approval persists the forged body value, upload
 * persists `0`, and a null `uploaderUserId` is silently swallowed — each
 * assertion below fails against that real, documented pre-change behavior.
 */

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

async function connectOrSkip(t) {
	const { default: pg } = await import("pg");
	const client = new pg.Client({
		connectionString: databaseUrl,
		connectionTimeoutMillis: 2000,
	});
	try {
		await client.connect();
	} catch (error) {
		t.skip(
			`DATABASE_URL not reachable (${databaseUrl}) — start Docker Postgres via infra/docker-compose.yml to run this integration test: ${error.message}`,
		);
		return null;
	}
	return client;
}

async function resetSchemaToHead(client) {
	const migrate = await import("../src/db/migrate.mjs");
	await migrate.migrateDown({ client }).catch(() => {});
	await migrate.migrateUp({ client });
}

/** Sets/deletes several env vars for the duration of `fn`, then restores them. */
async function withEnv(overrides, fn) {
	const previous = {};
	for (const key of Object.keys(overrides)) {
		previous[key] = process.env[key];
		if (overrides[key] === undefined) delete process.env[key];
		else process.env[key] = overrides[key];
	}
	try {
		return await fn();
	} finally {
		for (const key of Object.keys(previous)) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
}

async function freshModules() {
	const apiContract = await import("../src/api-contract.mjs");
	const authContract = await import("../src/auth-contract.mjs");
	const liveReviewPipeline = await import("../src/live-review-pipeline.mjs");
	const reviewRepositoryModule = await import("../src/db/review-repository.mjs");
	authContract._resetAuthContractForTests();
	liveReviewPipeline._resetLiveReviewPipelineForTests();
	return {
		handleApiRequest: apiContract.handleApiRequest,
		registerUploadedDocument: liveReviewPipeline.registerUploadedDocument,
		createReviewRepository: reviewRepositoryModule.createReviewRepository,
	};
}

async function auditEventsByType(client, eventType) {
	const result = await client.query(
		`SELECT actor_user_id, entity_type, entity_id, event_type
		 FROM audit_event WHERE event_type = $1 ORDER BY id`,
		[eventType],
	);
	return result.rows.map((row) => ({
		actorUserId: row.actor_user_id === null ? null : Number(row.actor_user_id),
		entityType: row.entity_type,
		entityId: row.entity_id === null ? null : Number(row.entity_id),
		eventType: row.event_type,
	}));
}

function pdfFile(name) {
	const content = Buffer.from(`%PDF-1.4 fake bytes for ${name} ${randomUUID()}`);
	return {
		filename: name,
		contentType: "application/pdf",
		content,
		size: content.byteLength,
	};
}

/** Seeds a real `thesis_document` + `review_workflow_item` pair directly via the repository, bypassing HTTP (this unit's own upload path is exercised separately below). */
async function seedBoardCard(client, createReviewRepository, { filename }) {
	const repository = createReviewRepository({ connectionString: databaseUrl });
	const documentId = await repository.insertThesisDocument({
		originalFilename: filename,
		contentType: "application/pdf",
		fileSizeBytes: 2048,
		storageKey: `thesis-documents/attribution-fixture/${filename}-${randomUUID()}`,
		sha256: createHash("sha256").update(`${filename}-${randomUUID()}`).digest("hex"),
		// Pre-existing/unattributed fixture row — irrelevant to what this unit
		// proves (approval attribution, not upload attribution).
		uploadedByUserId: 999,
	});
	const result = await client.query(
		"SELECT id FROM review_workflow_item WHERE thesis_document_id = $1",
		[documentId],
	);
	const workflowItemId = Number(result.rows[0].id);
	return { documentId, workflowItemId, boardCardId: `board_${workflowItemId}` };
}

test(
	"POST .../approval: a forged reviewerName body field never persists — only the authenticated session's real identity does",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);
			const session = await createAuthenticatedSession({
				connectionString: databaseUrl,
				displayName: "Dr. Ana Ruiz",
			});

			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { handleApiRequest, createReviewRepository } = await freshModules();
				const { boardCardId, workflowItemId } = await seedBoardCard(
					client,
					createReviewRepository,
					{ filename: "approval-attribution.pdf" },
				);

				const response = await handleApiRequest({
					method: "POST",
					path: `/api/v1/review-board/cards/${boardCardId}/approval`,
					body: { reviewerName: "Someone Else" },
					headers: session.headers,
				});
				assert.equal(response.status, 200);

				const row = await client.query(
					"SELECT reviewer_name, approved_by_reviewer_id FROM review_workflow_item WHERE id = $1",
					[workflowItemId],
				);
				assert.equal(
					row.rows[0].reviewer_name,
					"Dr. Ana Ruiz",
					"the persisted reviewer_name must be the authenticated session's real display name",
				);
				assert.equal(
					Number(row.rows[0].approved_by_reviewer_id),
					session.reviewerId,
					"approved_by_reviewer_id must be the authenticated session's real reviewer id",
				);
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"POST /api/v1/thesis-documents: a session-authenticated upload persists a real, non-zero uploaded_by_user_id, ignoring any body field",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);
			const session = await createAuthenticatedSession({
				connectionString: databaseUrl,
				displayName: "Dr. Grace Hopper",
			});

			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { handleApiRequest } = await freshModules();

				const response = await handleApiRequest({
					method: "POST",
					path: "/api/v1/thesis-documents",
					body: {
						files: [pdfFile("upload-attribution.pdf")],
						uploaderUserId: 0,
					},
					headers: session.headers,
				});
				assert.equal(response.status, 201);
				assert.notEqual(
					response.body.uploaded_by_user_id,
					0,
					"uploaded_by_user_id must never be the placeholder 0 once a session exists",
				);
				assert.equal(response.body.uploaded_by_user_id, session.reviewerId);

				const row = await client.query(
					"SELECT uploaded_by_user_id FROM thesis_document WHERE storage_key = $1",
					[response.body.storage_key],
				);
				assert.equal(Number(row.rows[0].uploaded_by_user_id), session.reviewerId);
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"registerUploadedDocument: a null/undefined uploaderUserId throws loudly instead of silently persisting 0",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);

			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { registerUploadedDocument } = await freshModules();

				await assert.rejects(
					() =>
						registerUploadedDocument({
							documentId: "doc_null_uploader_fixture",
							sha256: "b".repeat(64),
							storageKey: `thesis-documents/attribution-fixture/null-uploader-${randomUUID()}`,
							contentType: "application/pdf",
							filename: "null-uploader.pdf",
							fileSizeBytes: 1024,
							uploaderUserId: null,
						}),
					/uploaderUserId/i,
					"a null uploaderUserId must throw, never silently fall back to 0",
				);

				await assert.rejects(
					() =>
						registerUploadedDocument({
							documentId: "doc_undefined_uploader_fixture",
							sha256: "c".repeat(64),
							storageKey: `thesis-documents/attribution-fixture/undefined-uploader-${randomUUID()}`,
							contentType: "application/pdf",
							filename: "undefined-uploader.pdf",
							fileSizeBytes: 1024,
							uploaderUserId: undefined,
						}),
					/uploaderUserId/i,
					"an undefined uploaderUserId must throw, never silently fall back to 0",
				);

				const rows = await client.query(
					"SELECT count(*)::int AS n FROM thesis_document WHERE original_filename IN ($1, $2)",
					["null-uploader.pdf", "undefined-uploader.pdf"],
				);
				assert.equal(
					rows.rows[0].n,
					0,
					"the guarded call must never reach the database at all",
				);
			});
		} finally {
			await client.end();
		}
	},
);

test(
	"approving a card and uploading a thesis each write an audit_event row with the real acting reviewer's id",
	async (t) => {
		const client = await connectOrSkip(t);
		if (!client) return;
		try {
			await resetSchemaToHead(client);
			const session = await createAuthenticatedSession({
				connectionString: databaseUrl,
				displayName: "Dr. Audit Trail",
			});

			await withEnv({ DATABASE_URL: databaseUrl }, async () => {
				const { handleApiRequest, createReviewRepository } = await freshModules();

				const { boardCardId, workflowItemId } = await seedBoardCard(
					client,
					createReviewRepository,
					{ filename: "audit-approval.pdf" },
				);
				const approvalResponse = await handleApiRequest({
					method: "POST",
					path: `/api/v1/review-board/cards/${boardCardId}/approval`,
					body: {},
					headers: session.headers,
				});
				assert.equal(approvalResponse.status, 200);

				const approvedEvents = await auditEventsByType(client, "card_approved");
				assert.equal(approvedEvents.length, 1);
				assert.equal(approvedEvents[0].actorUserId, session.reviewerId);
				assert.equal(approvedEvents[0].entityId, workflowItemId);

				const uploadResponse = await handleApiRequest({
					method: "POST",
					path: "/api/v1/thesis-documents",
					body: { files: [pdfFile("audit-upload.pdf")] },
					headers: session.headers,
				});
				assert.equal(uploadResponse.status, 201);

				const uploadedEvents = await auditEventsByType(client, "thesis_uploaded");
				assert.equal(uploadedEvents.length, 1);
				assert.equal(uploadedEvents[0].actorUserId, session.reviewerId);

				const documentRow = await client.query(
					"SELECT id FROM thesis_document WHERE storage_key = $1",
					[uploadResponse.body.storage_key],
				);
				assert.equal(
					uploadedEvents[0].entityId,
					Number(documentRow.rows[0].id),
				);
			});
		} finally {
			await client.end();
		}
	},
);
