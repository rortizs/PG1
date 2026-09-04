import argon2 from "argon2";

/**
 * reviewer-authentication design.md D2: argon2id password hashing, sibling
 * of `provider-key-cipher.mjs`. OWASP-minimum parameters
 * `{ type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }`.
 *
 * The stored string is argon2's own self-describing PHC output
 * (`$argon2id$v=19$m=19456,t=2,p=1$…`) — `reviewer.password_hash TEXT` holds
 * it verbatim, no separate salt/params columns needed.
 */

const ARGON2_OPTIONS = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1,
};

/** Hashes `plaintext` into the PHC-encoded string persisted to `reviewer.password_hash`. */
export async function hashPassword(plaintext) {
	return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verifies `plaintext` against `hash`. NEVER throws — a malformed/corrupt
 * hash (or any other argon2 error) resolves to `false`, so a callsite can
 * always `await verifyPassword(...)` without a try/catch of its own.
 */
export async function verifyPassword(plaintext, hash) {
	try {
		return await argon2.verify(hash, plaintext);
	} catch {
		return false;
	}
}

/**
 * design.md D5 (enumeration closure): a fixed, pre-computed PHC hash burned
 * for unknown-email login attempts, so `verifyPassword(password,
 * DUMMY_PASSWORD_HASH)` costs the same argon2id work as a real verification
 * and response timing cannot distinguish "unknown email" from "known email,
 * wrong password". The plaintext behind this hash is never used for any real
 * account and is not a secret — its only property that matters is that it
 * is a valid PHC string this module can verify against.
 */
export const DUMMY_PASSWORD_HASH =
	"$argon2id$v=19$m=19456,t=2,p=1$Q6OJLDokilnhHM6FojzbWQ$/lp5CUNbt0gZnDd1BsBxVps7mZeR5AX8JHXX8l6fMtk";
