import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM at-rest encryption for LLM provider API keys (design decision
 * #4: authenticated encryption so tampering with stored ciphertext is
 * detected, not silently accepted like AES-CBC would be).
 *
 * Packed format: `v1:iv(b64):tag(b64):ciphertext(b64)` — a single string
 * column value, versioned so a future algorithm change can be introduced
 * without a destructive migration.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // NIST-recommended GCM IV length
const KEY_LENGTH_BYTES = 32; // AES-256
const KEY_HEX_LENGTH = KEY_LENGTH_BYTES * 2; // 64 hex chars
const PACK_VERSION = "v1";
export const ENCRYPTION_KEY_ENV_VAR = "LLM_PROVIDER_ENCRYPTION_KEY";

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * Thrown by every fail-fast validation path in this module. Never includes
 * the actual (invalid) key value in its message — only the expected shape —
 * so a misconfigured key can never leak into logs/error responses.
 */
export class EncryptionKeyError extends Error {}

/**
 * Fail-fast key validation (design decision #5): a missing, empty,
 * non-hex, or wrong-length key throws immediately rather than letting the
 * process proceed with an insecure or broken cipher configuration. Called
 * internally by every `encryptApiKey`/`decryptApiKey` call ("first cipher
 * use"), and eagerly by `provider-config-repository.mjs`'s composition root
 * the moment the admin subsystem is first touched (see that module for the
 * startup-fail-fast rationale).
 */
export function getEncryptionKey(env = process.env) {
	const raw = env[ENCRYPTION_KEY_ENV_VAR];
	if (!raw) {
		throw new EncryptionKeyError(
			`${ENCRYPTION_KEY_ENV_VAR} environment variable is required and must be a ${KEY_HEX_LENGTH}-character hex string (${KEY_LENGTH_BYTES} bytes). It is currently unset.`,
		);
	}
	if (raw.length !== KEY_HEX_LENGTH || !HEX_PATTERN.test(raw)) {
		throw new EncryptionKeyError(
			`${ENCRYPTION_KEY_ENV_VAR} must be exactly ${KEY_HEX_LENGTH} hex characters (${KEY_LENGTH_BYTES} bytes); got ${raw.length} character(s).`,
		);
	}
	return Buffer.from(raw, "hex");
}

/**
 * Encrypts `plaintext` (the raw API key) into the packed
 * `v1:iv:tag:ciphertext` string persisted to `llm_provider_config.encrypted_api_key`.
 * Never returns/logs the plaintext itself.
 */
export function encryptApiKey(plaintext, { env = process.env } = {}) {
	if (typeof plaintext !== "string" || plaintext.length === 0) {
		throw new TypeError("encryptApiKey: plaintext must be a non-empty string");
	}
	const key = getEncryptionKey(env);
	const iv = randomBytes(IV_LENGTH_BYTES);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const ciphertext = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const authTag = cipher.getAuthTag();
	return [
		PACK_VERSION,
		iv.toString("base64"),
		authTag.toString("base64"),
		ciphertext.toString("base64"),
	].join(":");
}

/**
 * Decrypts a packed `v1:iv:tag:ciphertext` string back to the plaintext API
 * key. Throws (GCM auth tag mismatch) if the packed value was tampered with
 * or corrupted — never returns a silently-wrong plaintext.
 */
export function decryptApiKey(packed, { env = process.env } = {}) {
	const key = getEncryptionKey(env);
	const parts = typeof packed === "string" ? packed.split(":") : null;
	if (!parts || parts.length !== 4 || parts[0] !== PACK_VERSION) {
		throw new Error(
			"decryptApiKey: malformed packed ciphertext (expected v1:iv:tag:ciphertext)",
		);
	}
	const [, ivB64, tagB64, ciphertextB64] = parts;
	const iv = Buffer.from(ivB64, "base64");
	const authTag = Buffer.from(tagB64, "base64");
	const ciphertext = Buffer.from(ciphertextB64, "base64");

	const decipher = createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(authTag);
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return plaintext.toString("utf8");
}

/** Last 4 characters of a plaintext API key, for masked display/storage. */
export function lastFour(plaintext) {
	if (typeof plaintext !== "string" || plaintext.length === 0) {
		throw new TypeError("lastFour: plaintext must be a non-empty string");
	}
	return plaintext.slice(-4);
}
