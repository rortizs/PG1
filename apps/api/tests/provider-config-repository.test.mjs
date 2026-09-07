import { test } from "node:test";
import assert from "node:assert/strict";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;
const VALID_ENCRYPTION_KEY = "d".repeat(64);

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

async function withEnv(overrides, fn) {
	const previous = {};
	for (const key of Object.keys(overrides)) {
		previous[key] = process.env[key];
		if (overrides[key] === undefined) delete process.env[key];
		else process.env[key] = overrides[key];
	}
	try {
		return await fn();
	} finally {
		for (const key of Object.keys(previous)) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
}

test("provider config repository resolves and activates providers per role", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrate.migrateUp({ client });
		await client.query("TRUNCATE TABLE llm_provider_config RESTART IDENTITY");

		await withEnv(
			{ LLM_PROVIDER_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY },
			async () => {
				const { createProviderConfigRepository } = await import(
					"../src/db/provider-config-repository.mjs"
				);
				const repository = createProviderConfigRepository({ client });

				const judgmentOne = await repository.create({
					providerName: "claude",
					role: "judgment",
					modelId: "claude-model-one",
					apiKey: "sk-judgment-one-secret",
				});
				const triage = await repository.create({
					providerName: "deepseek",
					role: "triage",
					modelId: "deepseek-chat",
					apiKey: "sk-triage-secret",
				});
				assert.equal(judgmentOne.role, "judgment");
				assert.equal(triage.role, "triage");

				assert.equal(
					await repository.getActiveProvider("triage"),
					null,
					"missing active triage provider is optional and returns null",
				);

				await repository.activate(judgmentOne.id);
				await repository.activate(triage.id);
				assert.deepEqual(await repository.getActiveProvider("judgment"), {
					providerName: "claude",
					role: "judgment",
					modelId: "claude-model-one",
					apiKey: "sk-judgment-one-secret",
				});
				assert.deepEqual(await repository.getActiveProvider("triage"), {
					providerName: "deepseek",
					role: "triage",
					modelId: "deepseek-chat",
					apiKey: "sk-triage-secret",
				});

				const judgmentTwo = await repository.create({
					providerName: "claude",
					role: "judgment",
					modelId: "claude-model-two",
					apiKey: "sk-judgment-two-secret",
				});
				await repository.activate(judgmentTwo.id);

				const rowsAfterJudgmentSwitch = await repository.list();
				assert.equal(
					rowsAfterJudgmentSwitch.find((row) => row.id === judgmentOne.id).is_active,
					false,
					"activating a judgment row deactivates only the previous judgment row",
				);
				assert.equal(
					rowsAfterJudgmentSwitch.find((row) => row.id === triage.id).is_active,
					true,
					"activating a judgment row must leave the active triage row untouched",
				);

				const triageTwo = await repository.create({
					providerName: "deepseek",
					role: "triage",
					modelId: "deepseek-reasoner",
					apiKey: "sk-triage-two-secret",
				});
				await repository.activate(triageTwo.id);

				const rowsAfterTriageSwitch = await repository.list();
				assert.equal(
					rowsAfterTriageSwitch.find((row) => row.id === judgmentTwo.id).is_active,
					true,
					"activating a triage row must leave the active judgment row untouched",
				);
				assert.equal(
					rowsAfterTriageSwitch.find((row) => row.id === triage.id).is_active,
					false,
					"activating a triage row deactivates only the previous triage row",
				);
			},
		);

		await client.query(
			"UPDATE llm_provider_config SET is_active = false WHERE role = 'triage'",
		);
		await migrate.migrateDown({ client });
	} finally {
		await client.end();
	}
});

test("provider config repository rejects unsupported roles before writing rows", async (t) => {
	const client = await connectOrSkip(t);
	if (!client) return;

	const migrate = await import("../src/db/migrate.mjs");
	try {
		await migrate.migrateDown({ client }).catch(() => {});
		await migrate.migrateUp({ client });
		await client.query("TRUNCATE TABLE llm_provider_config RESTART IDENTITY");

		await withEnv(
			{ LLM_PROVIDER_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY },
			async () => {
				const { createProviderConfigRepository } = await import(
					"../src/db/provider-config-repository.mjs"
				);
				const repository = createProviderConfigRepository({ client });

				await assert.rejects(
					() =>
						repository.create({
							providerName: "claude",
							role: "review",
							modelId: "claude-model",
							apiKey: "sk-invalid-role-secret",
						}),
					/role/i,
				);
				const count = await client.query(
					"SELECT count(*)::int AS count FROM llm_provider_config",
				);
				assert.equal(count.rows[0].count, 0);
			},
		);

		await migrate.migrateDown({ client });
	} finally {
		await client.end();
	}
});
