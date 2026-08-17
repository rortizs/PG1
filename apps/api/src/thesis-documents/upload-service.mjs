import { createHash } from "node:crypto";
import {
	buildStorageKey,
	createMemoryObjectStorage,
} from "../storage/object-storage.mjs";

export const ACCEPTED_THESIS_CONTENT_TYPES = new Set([
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
export const MAX_THESIS_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export async function processThesisDocumentUpload({
	files,
	uploaderUserId,
	storage = createMemoryObjectStorage(),
	metadata = {},
} = {}) {
	const fileValidation = validateExactlyOneFile(files);
	if (fileValidation) return fileValidation;

	const [file] = files;
	if (!ACCEPTED_THESIS_CONTENT_TYPES.has(file.contentType)) {
		return errorResponse(
			415,
			"unsupported_media_type",
			"Only PDF and DOCX thesis files are supported in the MVP.",
			{
				allowed_content_types: [...ACCEPTED_THESIS_CONTENT_TYPES],
				received_content_type: file.contentType ?? null,
				review_run_created: false,
			},
		);
	}

	const content = Buffer.isBuffer(file.content)
		? file.content
		: Buffer.from(file.content ?? "");
	const contentValidation = validateContentBytes(file, content);
	if (contentValidation) return contentValidation;

	const sha256 = createHash("sha256").update(content).digest("hex");
	const storageKey = buildStorageKey({
		keyPrefix: storage.keyPrefix,
		sha256,
		filename: file.filename,
	});

	const stored = await storage.putObject({
		key: storageKey,
		content,
		contentType: file.contentType,
		metadata: {
			original_filename: file.filename,
			uploader_user_id: uploaderUserId,
			...metadata,
		},
	});

	return {
		status: 201,
		body: {
			id: `doc_${sha256.slice(0, 16)}`,
			type: "thesis_document",
			status: "uploaded",
			upload_status: "uploaded",
			review_eligible: true,
			original_filename: file.filename,
			content_type: file.contentType,
			file_size_bytes: content.byteLength,
			storage_key: stored.key,
			storage_provider: stored.provider,
			sha256,
			uploaded_by_user_id: uploaderUserId,
			metadata,
			links: { self: `/api/v1/thesis-documents/doc_${sha256.slice(0, 16)}` },
		},
	};
}

function validateExactlyOneFile(files) {
	if (!Array.isArray(files) || files.length !== 1) {
		return errorResponse(
			422,
			"validation_error",
			"Upload requires exactly one thesis file.",
			{
				issues: [
					{
						field: "files",
						message: "Exactly one PDF or DOCX file is required.",
					},
				],
				review_run_created: false,
			},
		);
	}
	return null;
}

function validateContentBytes(file, content) {
	const issues = [];
	if (content.byteLength === 0) {
		issues.push({
			field: "files[0].content",
			message: "Thesis file content must not be empty.",
		});
	}
	if (file.size !== undefined && file.size !== content.byteLength) {
		issues.push({
			field: "files[0].size",
			message: "Declared file size must match actual content bytes.",
		});
	}
	if (content.byteLength > MAX_THESIS_FILE_SIZE_BYTES) {
		issues.push({
			field: "files[0].size",
			message: "Thesis file size must be 20 MB or smaller.",
		});
	}
	if (!issues.length) return null;
	return errorResponse(422, "validation_error", "Upload validation failed.", {
		issues,
		review_run_created: false,
	});
}

function errorResponse(status, error, message, details) {
	return {
		status,
		body: {
			error,
			message,
			details,
			request_id: "req_contract_stub",
			timestamp: new Date(0).toISOString(),
		},
	};
}
