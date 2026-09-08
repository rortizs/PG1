import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { normalizeEmail, validatePasswordStrength } from "../auth-contract.mjs";
import { hashPassword } from "../security/password-hasher.mjs";
import { createReviewerRepository } from "./reviewer-repository.mjs";

/**
 * reviewer-authentication design.md D10: operator-run reviewer provisioning.
 * Invocation matches `migrate.mjs` exactly — bare `node`, `DATABASE_URL` from
 * the environment, an `isMainModule` guard, `process.exitCode` on error, no
 * new `package.json` script.
 */

const REJECT_PASSWORD_FLAG_MESSAGE =
	"seed-reviewer.mjs: --password is not accepted as a flag — argv is visible in `ps` and lands in shell history. Use --generate, the REVIEWER_PASSWORD environment variable, or stdin.";

/**
 * Pure argv parser: no I/O, no password-source resolution (that happens in
 * `runCli()`, since it may require a stdin read). Returns `{ email,
 * displayName, mode, generate }` or `{ error }`.
 */
export function parseSeedArgs(argv) {
	const parsed = {
		email: null,
		displayName: null,
		generate: false,
		resetPassword: false,
		deactivate: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		switch (token) {
			case "--password":
				return { error: REJECT_PASSWORD_FLAG_MESSAGE };
			case "--email":
				parsed.email = argv[i + 1] ?? null;
				i += 1;
				break;
			case "--display-name":
				parsed.displayName = argv[i + 1] ?? null;
				i += 1;
				break;
			case "--generate":
				parsed.generate = true;
				break;
			case "--reset-password":
				parsed.resetPassword = true;
				break;
			case "--deactivate":
				parsed.deactivate = true;
				break;
			default:
				return { error: `seed-reviewer.mjs: unrecognized argument "${token}"` };
		}
	}

	if (!parsed.email) {
		return { error: "seed-reviewer.mjs: --email is required" };
	}

	if (parsed.deactivate) {
		return {
			email: parsed.email,
			displayName: parsed.displayName,
			mode: "deactivate",
			generate: false,
		};
	}

	if (parsed.resetPassword) {
		return {
			email: parsed.email,
			displayName: parsed.displayName,
			mode: "reset-password",
			generate: parsed.generate,
		};
	}

	if (!parsed.displayName) {
		return { error: "seed-reviewer.mjs: --display-name is required to create a reviewer" };
	}

	return {
		email: parsed.email,
		displayName: parsed.displayName,
		mode: "create",
		generate: parsed.generate,
	};
}

/**
 * Creates, resets the password of, or deactivates a reviewer account,
 * depending on `mode`. Never returns or logs `password` — the caller (the
 * CLI entrypoint) is the only place the plaintext is ever displayed, and
 * only once.
 */
export async function seedReviewer({ connectionString, email, displayName, password, mode }) {
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) {
		throw new Error(`seed-reviewer.mjs: "${email}" is not a valid email address`);
	}

	const repository = createReviewerRepository({ connectionString });
	const existing = await repository.findByEmail(normalizedEmail);

	if (mode === "deactivate") {
		if (!existing) {
			throw new Error(`seed-reviewer.mjs: no reviewer exists with email "${normalizedEmail}"`);
		}
		await repository.setActive(existing.id, false);
		return { id: existing.id, email: normalizedEmail, displayName: existing.displayName, isActive: false };
	}

	const strengthIssue = validatePasswordStrength(password);
	if (strengthIssue) {
		throw new Error(`seed-reviewer.mjs: ${strengthIssue.message}`);
	}
	const passwordHash = await hashPassword(password);

	if (mode === "reset-password") {
		if (!existing) {
			throw new Error(`seed-reviewer.mjs: no reviewer exists with email "${normalizedEmail}"`);
		}
		await repository.resetPassword(existing.id, passwordHash);
		return { id: existing.id, email: normalizedEmail, displayName: existing.displayName, isActive: existing.isActive };
	}

	// mode === "create"
	if (existing) {
		throw new Error(
			`seed-reviewer.mjs: reviewer already exists — use --reset-password`,
		);
	}
	return repository.createReviewer({ email: normalizedEmail, passwordHash, displayName });
}

function generatePassword() {
	// 24 random bytes -> 32 base64url chars, comfortably above MIN_PASSWORD_LENGTH.
	return randomBytes(24).toString("base64url");
}

/** Reads a password from stdin with echo suppressed when stdin is a TTY. */
async function readPasswordFromStdin() {
	return new Promise((resolve, reject) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
		if (process.stdin.isTTY) {
			process.stdout.write("Password (input hidden): ");
			process.stdin.setRawMode?.(true);
		}
		let value = "";
		process.stdin.on("data", (chunk) => {
			const str = chunk.toString("utf8");
			if (str === "\n" || str === "\r" || str === "\r\n") {
				process.stdin.setRawMode?.(false);
				process.stdout.write("\n");
				rl.close();
				resolve(value);
				return;
			}
			if (!process.stdin.isTTY) return; // rl 'line' handles the non-TTY case
			value += str;
		});
		rl.on("line", (line) => {
			if (!process.stdin.isTTY) resolve(line);
		});
		rl.on("error", reject);
	});
}

async function resolvePassword(generate) {
	if (generate) return generatePassword();
	if (process.env.REVIEWER_PASSWORD) return process.env.REVIEWER_PASSWORD;
	return readPasswordFromStdin();
}

async function runCli() {
	const parsed = parseSeedArgs(process.argv.slice(2));
	if (parsed.error) {
		console.error(parsed.error);
		process.exitCode = 1;
		return;
	}

	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		console.error("seed-reviewer.mjs: DATABASE_URL environment variable is required");
		process.exitCode = 1;
		return;
	}

	const password =
		parsed.mode === "deactivate" ? "" : await resolvePassword(parsed.generate);

	const result = await seedReviewer({
		connectionString,
		email: parsed.email,
		displayName: parsed.displayName,
		password,
		mode: parsed.mode,
	});

	if (parsed.generate && parsed.mode !== "deactivate") {
		// Printed exactly once, on its own line, obviously prefixed — never
		// logged again, and the hash itself is never printed.
		console.log(`seed-reviewer.mjs: generated password (copy now, shown once): ${password}`);
	}
	console.log(`seed-reviewer.mjs: ${parsed.mode} completed for ${result.email} (id=${result.id})`);
}

const isMainModule =
	process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
	runCli().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
