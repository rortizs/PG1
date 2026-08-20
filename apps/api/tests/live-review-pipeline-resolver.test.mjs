import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * thesis-normative-governance PR1 "governance spine", Work Unit 4
 * (design.md D4): `resolveNormativeSourceId`'s cached key space widens to
 * cover BOTH corpus filenames (`seedNormativeSources()`'s `idByFile`, the
 * pre-existing CAG path) AND `source_type` values
 * (`getNormativeSourceIdsBySourceType()`, the new rules-engine path) inside
 * the SAME single cache — not a forked/parallel resolver.
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

test("resolveNormativeSourceId resolves a source_type ref (e.g. 'apa_6') to a real, non-null id — not the pre-change null", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	const { createReviewRepository } = await import(
		"../src/db/review-repository.mjs"
	);
	const { resolveNormativeSourceId } = await import(
		"../src/live-review-pipeline.mjs"
	);

	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrate.migrateUp({ client });

		const repository = createReviewRepository({ client });
		await repository.seedNormativeSources();

		const apa6Id = await resolveNormativeSourceId(repository, "apa_6");
		const gtGuideId = await resolveNormativeSourceId(repository, "gt_guide");
		const reglamentoId = await resolveNormativeSourceId(
			repository,
			"reglamento_tesis",
		);

		assert.ok(Number.isInteger(apa6Id));
		assert.ok(Number.isInteger(gtGuideId));
		assert.ok(Number.isInteger(reglamentoId));

		await migrate.migrateDown({ client });
	} finally {
		await client.end();
	}
});

test("resolveNormativeSourceId still resolves a corpus-filename ref (byte-identical CAG path) once the key space is widened", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	const { createReviewRepository } = await import(
		"../src/db/review-repository.mjs"
	);
	const { resolveNormativeSourceId } = await import(
		"../src/live-review-pipeline.mjs"
	);

	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrate.migrateUp({ client });

		const repository = createReviewRepository({ client });
		const idsByFile = await repository.seedNormativeSources();

		const filenameId = await resolveNormativeSourceId(
			repository,
			"lineamientos_ingenieria_sistemas.txt",
		);

		assert.equal(
			filenameId,
			idsByFile["lineamientos_ingenieria_sistemas.txt"],
		);

		await migrate.migrateDown({ client });
	} finally {
		await client.end();
	}
});

test("resolveNormativeSourceId resolves BOTH a filename key and a source_type key in the same run, without collision", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	const { createReviewRepository } = await import(
		"../src/db/review-repository.mjs"
	);
	const { resolveNormativeSourceId } = await import(
		"../src/live-review-pipeline.mjs"
	);

	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrate.migrateUp({ client });

		const repository = createReviewRepository({ client });
		const idsByFile = await repository.seedNormativeSources();

		const filenameId = await resolveNormativeSourceId(
			repository,
			"lineamientos_ingenieria_sistemas.txt",
		);
		const typeId = await resolveNormativeSourceId(repository, "apa_6");
		const unknownRef = await resolveNormativeSourceId(
			repository,
			"not_a_real_ref",
		);

		assert.equal(
			filenameId,
			idsByFile["lineamientos_ingenieria_sistemas.txt"],
		);
		assert.ok(Number.isInteger(typeId));
		assert.equal(unknownRef, null);

		await migrate.migrateDown({ client });
	} finally {
		await client.end();
	}
});
