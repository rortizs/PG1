import { createHash, timingSafeEqual } from "node:crypto";
import { createProviderConfigRepository } from "./db/provider-config-repository.mjs";
import { EncryptionKeyError } from "./security/provider-key-cipher.mjs";

/**
 * Admin CRUD/activate request handling for `llm_provider_config`, kept in
 * its own isolated module (design decision #7) so the contract-tested
 * `api-contract.mjs`/`contract.test.mjs` seam stays byte-untouched.
 *
 * `x-admin-secret` shared-secret gate (design decision #6): an explicit,
 * documented TEMPORARY MVP measure — NOT real authentication/authorization.
 * Never present it as such in UI copy or docs.
 */

const SUPPORTED_PROVIDER_NAMES = ["claude", "deepseek", "groq"];

const ROUTES = [
	["GET", "/api/v1/admin/llm-providers"],
	["POST", "/api/v1/admin/llm-providers"],
	["PATCH", "/api/v1/admin/llm-providers/{id}"],
	["POST", "/api/v1/admin/llm-providers/{id}/activate"],
];

export function listAdminRoutes() {
	return ROUTES.map(([method, path]) => ({ method, path }));
}

let cachedRepository;

function databaseUrl() {
	return process.env.DATABASE_URL || null;
}

/**
 * Lazily constructs (and caches) the admin repository. Repository
 * construction itself validates `LLM_PROVIDER_ENCRYPTION_KEY` fail-fast
 * (see `provider-config-repository.mjs`) — so a misconfigured key surfaces
 * on the very first admin request, of any kind, rather than the process
 * silently starting in an insecure state.
 */
function getRepository() {
	const connectionString = databaseUrl();
	if (!connectionString) return { error: "database_not_configured" };
	if (!cachedRepository) {
		cachedRepository = createProviderConfigRepository({ connectionString });
	}
	return { repository: cachedRepository };
}

export async function handleAdminRequest({
	method,
	path,
	query = {},
	body = {},
	headers = {},
}) {
	const normalizedMethod = method.toUpperCase();

	const authError = checkAdminSecretHeader(headers);
	if (authError) return authError;

	if (normalizedMethod === "GET" && path === "/api/v1/admin/llm-providers") {
		return withRepository(async (repository) => {
			const items = await repository.list();
			return ok({ items });
		});
	}

	if (normalizedMethod === "POST" && path === "/api/v1/admin/llm-providers") {
		const validation = validateCreatePayload(body);
		if (validation.error) return validation.error;
		return withRepository(async (repository) => {
			const created = await repository.create(validation.value);
			return { status: 201, body: created };
		});
	}

	const updateMatch = path.match(/^\/api\/v1\/admin\/llm-providers\/([^/]+)$/);
	if (normalizedMethod === "PATCH" && updateMatch) {
		const id = decodeURIComponent(updateMatch[1]);
		const validation = validateUpdatePayload(body);
		if (validation.error) return validation.error;
		return withRepository(async (repository) => {
			const updated = await repository.update(id, validation.value);
			if (!updated) {
				return errorResponse(
					404,
					"not_found",
					"No llm_provider_config row exists with that id.",
					{ id },
				);
			}
			return ok(updated);
		});
	}

	const activateMatch = path.match(
		/^\/api\/v1\/admin\/llm-providers\/([^/]+)\/activate$/,
	);
	if (normalizedMethod === "POST" && activateMatch) {
		const id = decodeURIComponent(activateMatch[1]);
		return withRepository(async (repository) => {
			const activated = await repository.activate(id);
			if (!activated) {
				return errorResponse(
					404,
					"not_found",
					"No llm_provider_config row exists with that id.",
					{ id },
				);
			}
			return ok(activated);
		});
	}

	return errorResponse(404, "not_found", "Admin API route was not found.", {
		method: normalizedMethod,
		path,
	});
}

async function withRepository(fn) {
	try {
		const resolved = getRepository();
		if (resolved.error) {
			return errorResponse(
				503,
				"service_unavailable",
				"The admin API requires DATABASE_URL to be configured.",
				{},
			);
		}
		return await fn(resolved.repository);
	} catch (error) {
		if (error instanceof EncryptionKeyError) {
			// Never include the (invalid/missing) key value itself — this
			// error's own message intentionally never contains it.
			return errorResponse(
				500,
				"configuration_error",
				"The LLM provider encryption key is not configured correctly.",
				{},
			);
		}
		return errorResponse(
			500,
			"internal_error",
			"The admin request could not be completed.",
			{ reason: error.message },
		);
	}
}

/**
 * Shared field validators for create/update payloads. `required: true`
 * (create) rejects `undefined`; `required: false` (update) treats
 * `undefined` as "not being changed" and skips validation for that field —
 * the one behavioral difference between create and update payloads.
 */
function validateProviderNameField(value, { required }, issues) {
	if (value === undefined && !required) return;
	if (!SUPPORTED_PROVIDER_NAMES.includes(value)) {
		issues.push({
			field: "provider_name",
			message: `Must be one of: ${SUPPORTED_PROVIDER_NAMES.join(", ")}.`,
		});
	}
}

function validateNonEmptyStringField(field, value, { required }, issues) {
	if (value === undefined && !required) return;
	if (typeof value !== "string" || value.trim() === "") {
		issues.push({ field, message: "Must be a non-empty string." });
	}
}

function validationErrorOrValue(issues, value) {
	if (issues.length) {
		return {
			error: errorResponse(422, "validation_error", "Request validation failed.", {
				issues,
			}),
		};
	}
	return { value };
}

function validateCreatePayload(body) {
	const issues = [];
	validateProviderNameField(body?.provider_name, { required: true }, issues);
	validateNonEmptyStringField("model_id", body?.model_id, { required: true }, issues);
	validateNonEmptyStringField("api_key", body?.api_key, { required: true }, issues);
	return validationErrorOrValue(issues, {
		providerName: body?.provider_name,
		modelId: body?.model_id,
		apiKey: body?.api_key,
		metadata: body?.metadata ?? {},
	});
}

function validateUpdatePayload(body) {
	const issues = [];
	validateProviderNameField(body?.provider_name, { required: false }, issues);
	validateNonEmptyStringField("model_id", body?.model_id, { required: false }, issues);
	validateNonEmptyStringField("api_key", body?.api_key, { required: false }, issues);
	return validationErrorOrValue(issues, {
		providerName: body?.provider_name,
		modelId: body?.model_id,
		apiKey: body?.api_key,
		metadata: body?.metadata,
	});
}

/**
 * Constant-time (digest-based, so mismatched lengths never leak via early
 * exit) comparison of the request's `x-admin-secret` header against
 * `ADMIN_SHARED_SECRET`. Returns `null` when the request may proceed, or a
 * standard-shaped `401`/`403` error response otherwise.
 */
export function checkAdminSecretHeader(headers) {
	const provided = lookupHeader(headers, "x-admin-secret");
	if (!provided) {
		return errorResponse(
			401,
			"unauthorized",
			"The x-admin-secret header is required for admin requests.",
			{},
		);
	}
	const expected = process.env.ADMIN_SHARED_SECRET || "";
	if (!expected || !constantTimeEquals(provided, expected)) {
		return errorResponse(
			403,
			"forbidden",
			"The provided admin secret is not valid.",
			{},
		);
	}
	return null;
}

function constantTimeEquals(a, b) {
	const digestA = createHash("sha256").update(String(a)).digest();
	const digestB = createHash("sha256").update(String(b)).digest();
	return timingSafeEqual(digestA, digestB);
}

function lookupHeader(headers, name) {
	if (!headers) return undefined;
	const lowerName = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lowerName) return headers[key];
	}
	return undefined;
}

function ok(body) {
	return { status: 200, body };
}

function errorResponse(status, error, message, details) {
	return {
		status,
		body: {
			error,
			message,
			details,
			request_id: "req_admin_contract",
			timestamp: new Date().toISOString(),
		},
	};
}

/** Test-only escape hatch: clears the cached repository singleton. */
export function _resetAdminContractForTests() {
	cachedRepository = undefined;
}
