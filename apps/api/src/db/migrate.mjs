import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

export const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

/**
 * Splits a migration SQL file into its "-- UP" and "-- DOWN" sections.
 * Throws an explicit error when either marker is missing, rather than
 * silently applying a partial/empty statement.
 */
export function splitMigration(sql) {
	const upMatch = sql.match(/--\s*UP\s*\r?\n([\s\S]*?)--\s*DOWN\s*\r?\n/i);
	const downMatch = sql.match(/--\s*DOWN\s*\r?\n([\s\S]*)$/i);

	if (!upMatch || !downMatch) {
		throw new Error(
			'migrate.mjs: migration SQL must contain both a "-- UP" and a "-- DOWN" marker',
		);
	}

	return {
		up: upMatch[1].trim(),
		down: downMatch[1].trim(),
	};
}

/**
 * Discovers every `*.sql` migration file under `dir` and returns their
 * `file://` URLs sorted ascending by filename. Filename order IS the
 * migration order (e.g. `0001_...sql` before `0002_...sql`); callers that
 * need rollback order reverse the returned array themselves.
 */
export async function listMigrationFiles(dir = MIGRATIONS_DIR) {
	const entries = await readdir(dir);
	return entries
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => new URL(name, dir));
}

export async function readMigration(path) {
	const sql = await readFile(path, "utf8");
	return splitMigration(sql);
}

/**
 * Shared connection helper: runs `run(pgClient)` against either a caller-owned
 * `client` (left open afterwards) or a fresh client opened from
 * `connectionString` (closed afterwards). Exported so other modules that
 * need a plain `pg` client — e.g. `review-repository.mjs` — do not
 * reimplement this connect/close bookkeeping.
 */
export async function withClient({ client, connectionString }, run) {
	const ownsClient = !client;
	const pgClient = client ?? new Client({ connectionString });

	if (ownsClient) {
		await pgClient.connect();
	}

	try {
		return await run(pgClient);
	} finally {
		if (ownsClient) {
			await pgClient.end();
		}
	}
}

async function runMigrationFiles(paths, pgClient, section) {
	for (const path of paths) {
		const migration = await readMigration(path);
		await pgClient.query(migration[section]);
	}
}

export async function migrateUp({
	client,
	connectionString,
	migrationPath,
	migrationsDir,
} = {}) {
	const paths = migrationPath
		? [migrationPath]
		: await listMigrationFiles(migrationsDir);

	return withClient({ client, connectionString }, (pgClient) =>
		runMigrationFiles(paths, pgClient, "up"),
	);
}

export async function migrateDown({
	client,
	connectionString,
	migrationPath,
	migrationsDir,
} = {}) {
	const paths = migrationPath
		? [migrationPath]
		: (await listMigrationFiles(migrationsDir)).reverse();

	return withClient({ client, connectionString }, (pgClient) =>
		runMigrationFiles(paths, pgClient, "down"),
	);
}

async function runCli() {
	const direction = process.argv[2];
	const connectionString = process.env.DATABASE_URL;

	if (direction !== "up" && direction !== "down") {
		console.error("Usage: node apps/api/src/db/migrate.mjs <up|down>");
		process.exitCode = 1;
		return;
	}

	if (!connectionString) {
		console.error(
			"migrate.mjs: DATABASE_URL environment variable is required",
		);
		process.exitCode = 1;
		return;
	}

	const action = direction === "up" ? migrateUp : migrateDown;
	await action({ connectionString });
	console.log(`migrate.mjs: ${direction} completed against ${connectionString}`);
}

const isMainModule =
	process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
	runCli().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
