import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

export const DEFAULT_MIGRATION_PATH = new URL(
	"./migrations/0001_schema_baseline.sql",
	import.meta.url,
);

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

export async function readMigration(path = DEFAULT_MIGRATION_PATH) {
	const sql = await readFile(path, "utf8");
	return splitMigration(sql);
}

async function withClient({ client, connectionString }, run) {
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

export async function migrateUp({
	client,
	connectionString,
	migrationPath,
} = {}) {
	const { up } = await readMigration(migrationPath);
	return withClient({ client, connectionString }, (pgClient) =>
		pgClient.query(up),
	);
}

export async function migrateDown({
	client,
	connectionString,
	migrationPath,
} = {}) {
	const { down } = await readMigration(migrationPath);
	return withClient({ client, connectionString }, (pgClient) =>
		pgClient.query(down),
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
