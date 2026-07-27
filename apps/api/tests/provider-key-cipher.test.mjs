import { test } from "node:test";
import assert from "node:assert/strict";

const ENV_VAR = "LLM_PROVIDER_ENCRYPTION_KEY";
const VALID_KEY_HEX = "a".repeat(64); // 64 hex chars = 32 bytes (AES-256)

/**
 * Runs `fn` with `LLM_PROVIDER_ENCRYPTION_KEY` set to `value` (or deleted
 * when `value` is `undefined`), restoring whatever was there before —
 * per this pass's constraint, no `.env` file is used; the key is set
 * directly on `process.env` for the lifetime of each test.
 */
async function withEnvKey(value, fn) {
	const previous = process.env[ENV_VAR];
	if (value === undefined) delete process.env[ENV_VAR];
	else process.env[ENV_VAR] = value;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env[ENV_VAR];
		else process.env[ENV_VAR] = previous;
	}
}

test("encryptApiKey -> decryptApiKey round-trips the original plaintext", async () => {
	const { encryptApiKey, decryptApiKey } = await import(
		"../src/security/provider-key-cipher.mjs"
	);
	await withEnvKey(VALID_KEY_HEX, () => {
		const packed = encryptApiKey("sk-ant-super-secret-1234");
		assert.notEqual(packed, "sk-ant-super-secret-1234");
		assert.match(packed, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
		const plaintext = decryptApiKey(packed);
		assert.equal(plaintext, "sk-ant-super-secret-1234");
	});
});

test("encryptApiKey produces a different ciphertext each time (random IV) but both decrypt correctly", async () => {
	const { encryptApiKey, decryptApiKey } = await import(
		"../src/security/provider-key-cipher.mjs"
	);
	await withEnvKey(VALID_KEY_HEX, () => {
		const packedA = encryptApiKey("sk-ant-same-plaintext");
		const packedB = encryptApiKey("sk-ant-same-plaintext");
		assert.notEqual(packedA, packedB);
		assert.equal(decryptApiKey(packedA), "sk-ant-same-plaintext");
		assert.equal(decryptApiKey(packedB), "sk-ant-same-plaintext");
	});
});

test("tampering with the packed ciphertext is detected and rejected (GCM auth tag failure)", async () => {
	const { encryptApiKey, decryptApiKey } = await import(
		"../src/security/provider-key-cipher.mjs"
	);
	await withEnvKey(VALID_KEY_HEX, () => {
		const packed = encryptApiKey("sk-ant-tamper-me");
		const [version, iv, tag, ciphertext] = packed.split(":");
		// Flip the ciphertext's own bytes (not just re-encode) so the tamper is
		// a genuine bit-flip, not a base64-padding no-op.
		const tamperedBuffer = Buffer.from(ciphertext, "base64");
		tamperedBuffer[0] = tamperedBuffer[0] ^ 0xff;
		const tamperedPacked = [version, iv, tag, tamperedBuffer.toString("base64")].join(
			":",
		);
		assert.throws(() => decryptApiKey(tamperedPacked));
	});
});

test("tampering with the auth tag is detected and rejected", async () => {
	const { encryptApiKey, decryptApiKey } = await import(
		"../src/security/provider-key-cipher.mjs"
	);
	await withEnvKey(VALID_KEY_HEX, () => {
		const packed = encryptApiKey("sk-ant-tamper-tag");
		const [version, iv, tag, ciphertext] = packed.split(":");
		const tamperedTagBuffer = Buffer.from(tag, "base64");
		tamperedTagBuffer[0] = tamperedTagBuffer[0] ^ 0xff;
		const tamperedPacked = [version, iv, tamperedTagBuffer.toString("base64"), ciphertext].join(
			":",
		);
		assert.throws(() => decryptApiKey(tamperedPacked));
	});
});

test("getEncryptionKey() throws fail-fast when LLM_PROVIDER_ENCRYPTION_KEY is missing", async () => {
	const { getEncryptionKey, EncryptionKeyError } = await import(
		"../src/security/provider-key-cipher.mjs"
	);
	await withEnvKey(undefined, () => {
		assert.throws(() => getEncryptionKey(), EncryptionKeyError);
	});
});

test("getEncryptionKey() throws fail-fast when LLM_PROVIDER_ENCRYPTION_KEY is an empty string", async () => {
	const { getEncryptionKey, EncryptionKeyError } = await import(
		"../src/security/provider-key-cipher.mjs"
	);
	await withEnvKey("", () => {
		assert.throws(() => getEncryptionKey(), EncryptionKeyError);
	});
});

test("getEncryptionKey() throws fail-fast when LLM_PROVIDER_ENCRYPTION_KEY contains non-hex characters", async () => {
	const { getEncryptionKey, EncryptionKeyError } = await import(
		"../src/security/provider-key-cipher.mjs"
	);
	await withEnvKey("z".repeat(64), () => {
		assert.throws(() => getEncryptionKey(), EncryptionKeyError);
	});
});

test("getEncryptionKey() throws fail-fast when LLM_PROVIDER_ENCRYPTION_KEY is the wrong byte length (too short)", async () => {
	const { getEncryptionKey, EncryptionKeyError } = await import(
		"../src/security/provider-key-cipher.mjs"
	);
	await withEnvKey("a".repeat(62), () => {
		assert.throws(() => getEncryptionKey(), EncryptionKeyError);
	});
});

test("getEncryptionKey() throws fail-fast when LLM_PROVIDER_ENCRYPTION_KEY is the wrong byte length (too long)", async () => {
	const { getEncryptionKey, EncryptionKeyError } = await import(
		"../src/security/provider-key-cipher.mjs"
	);
	await withEnvKey("a".repeat(66), () => {
		assert.throws(() => getEncryptionKey(), EncryptionKeyError);
	});
});

test("getEncryptionKey() returns a 32-byte Buffer for a valid 64-hex-char key", async () => {
	const { getEncryptionKey } = await import("../src/security/provider-key-cipher.mjs");
	await withEnvKey(VALID_KEY_HEX, () => {
		const key = getEncryptionKey();
		assert.ok(Buffer.isBuffer(key));
		assert.equal(key.length, 32);
	});
});

test("encryptApiKey() itself fails fast (never silently proceeds) when the key is missing", async () => {
	const { encryptApiKey, EncryptionKeyError } = await import(
		"../src/security/provider-key-cipher.mjs"
	);
	await withEnvKey(undefined, () => {
		assert.throws(() => encryptApiKey("sk-ant-never-stored"), EncryptionKeyError);
	});
});

test("decryptApiKey() itself fails fast (never silently proceeds) when the key is missing", async () => {
	const { decryptApiKey, EncryptionKeyError } = await import(
		"../src/security/provider-key-cipher.mjs"
	);
	await withEnvKey(undefined, () => {
		assert.throws(
			() => decryptApiKey("v1:aa==:bb==:cc=="),
			EncryptionKeyError,
		);
	});
});
