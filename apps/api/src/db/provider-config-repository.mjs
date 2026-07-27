import { withClient } from "./migrate.mjs";
import {
	decryptApiKey,
	encryptApiKey,
	getEncryptionKey,
	lastFour,
} from "../security/provider-key-cipher.mjs";

/**
 * `pg` returns BIGINT columns as strings; every id in this schema is
 * `GENERATED ALWAYS AS IDENTITY`, so values stay far below
 * `Number.MAX_SAFE_INTEGER` — coerce to a plain JS number, matching
 * `review-repository.mjs`'s own `toId` convention.
 */
function toId(value) {
	return value === null || value === undefined ? value : Number(value);
}

/**
 * Maps a raw `llm_provider_config` row to the masked view every admin
 * response returns. Deliberately an explicit allowlist (never a spread of
 * the raw row) so `encrypted_api_key` can never leak even if a future
 * `SELECT *` accidentally includes it.
 */
function toMaskedView(row) {
	return {
		id: toId(row.id),
		type: "llm_provider_config",
		provider_name: row.provider_name,
		model_id: row.model_id,
		api_key_last_four: row.api_key_last_four,
		is_active: row.is_active,
		metadata: row.metadata ?? {},
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

/**
 * CRUD + activate persistence for `llm_provider_config`, plus
 * `getActiveProvider()` (consumed by the review pipeline in a later work
 * unit). Encrypts on write, decrypts only in `getActiveProvider()` — every
 * other read path (`list`, `create`, `update`, `activate`) returns the
 * masked view only.
 *
 * Fail-fast (design decision #5): validates `LLM_PROVIDER_ENCRYPTION_KEY`
 * the moment this repository is constructed — i.e. before the admin
 * subsystem serves its first request of any kind, not merely lazily on the
 * first write — so a misconfigured key surfaces immediately instead of
 * failing unpredictably deep inside a later encrypt/decrypt call.
 */
export function createProviderConfigRepository({ client, connectionString, env } = {}) {
	// Fail fast at construction time — before any DB I/O is attempted.
	getEncryptionKey(env);

	const run = (fn) => withClient({ client, connectionString }, fn);

	return {
		async list() {
			return run(async (pgClient) => {
				const result = await pgClient.query(
					`SELECT id, provider_name, model_id, api_key_last_four, is_active, metadata, created_at, updated_at
					 FROM llm_provider_config
					 ORDER BY id`,
				);
				return result.rows.map(toMaskedView);
			});
		},

		async create({ providerName, modelId, apiKey, metadata = {} }) {
			const encryptedApiKey = encryptApiKey(apiKey, { env });
			const apiKeyLastFour = lastFour(apiKey);
			return run(async (pgClient) => {
				const result = await pgClient.query(
					`INSERT INTO llm_provider_config
					   (provider_name, model_id, encrypted_api_key, api_key_last_four, is_active, metadata)
					 VALUES ($1, $2, $3, $4, false, $5)
					 RETURNING id, provider_name, model_id, api_key_last_four, is_active, metadata, created_at, updated_at`,
					[providerName, modelId, encryptedApiKey, apiKeyLastFour, JSON.stringify(metadata)],
				);
				return toMaskedView(result.rows[0]);
			});
		},

		/**
		 * `modelId`/`metadata` are updated only when explicitly provided.
		 * `apiKey` is write-only: when omitted, the previously stored
		 * encrypted key and its masked last-four are left untouched — the
		 * plaintext is never re-read or re-exposed on an update.
		 */
		async update(id, { providerName, modelId, apiKey, metadata } = {}) {
			const encryptedApiKey =
				apiKey !== undefined ? encryptApiKey(apiKey, { env }) : null;
			const apiKeyLastFour = apiKey !== undefined ? lastFour(apiKey) : null;

			return run(async (pgClient) => {
				const result = await pgClient.query(
					`UPDATE llm_provider_config SET
					   provider_name = COALESCE($2, provider_name),
					   model_id = COALESCE($3, model_id),
					   encrypted_api_key = COALESCE($4, encrypted_api_key),
					   api_key_last_four = COALESCE($5, api_key_last_four),
					   metadata = COALESCE($6, metadata),
					   updated_at = now()
					 WHERE id = $1
					 RETURNING id, provider_name, model_id, api_key_last_four, is_active, metadata, created_at, updated_at`,
					[
						id,
						providerName ?? null,
						modelId ?? null,
						encryptedApiKey,
						apiKeyLastFour,
						metadata !== undefined ? JSON.stringify(metadata) : null,
					],
				);
				if (result.rows.length === 0) return null;
				return toMaskedView(result.rows[0]);
			});
		},

		/**
		 * Atomically deactivates any currently-active row, then activates
		 * `id` — a single transaction so the DB's partial unique index on
		 * `is_active` (design decision #3) is never transiently violated and
		 * a concurrent activate can never leave two rows active.
		 */
		async activate(id) {
			return run(async (pgClient) => {
				await pgClient.query("BEGIN");
				try {
					await pgClient.query(
						"UPDATE llm_provider_config SET is_active = false, updated_at = now() WHERE is_active = true",
					);
					const result = await pgClient.query(
						`UPDATE llm_provider_config SET is_active = true, updated_at = now()
						 WHERE id = $1
						 RETURNING id, provider_name, model_id, api_key_last_four, is_active, metadata, created_at, updated_at`,
						[id],
					);
					await pgClient.query("COMMIT");
					if (result.rows.length === 0) return null;
					return toMaskedView(result.rows[0]);
				} catch (error) {
					await pgClient.query("ROLLBACK");
					throw error;
				}
			});
		},

		/**
		 * Resolves + decrypts the currently active provider for the review
		 * pipeline (consumed starting in a later work unit). Returns `null`
		 * when no row is active — callers must treat that as "no active LLM
		 * provider configured", never a silent fallback.
		 */
		async getActiveProvider() {
			return run(async (pgClient) => {
				const result = await pgClient.query(
					`SELECT provider_name, model_id, encrypted_api_key
					 FROM llm_provider_config
					 WHERE is_active = true
					 LIMIT 1`,
				);
				if (result.rows.length === 0) return null;
				const row = result.rows[0];
				return {
					providerName: row.provider_name,
					modelId: row.model_id,
					apiKey: decryptApiKey(row.encrypted_api_key, { env }),
				};
			});
		},
	};
}
