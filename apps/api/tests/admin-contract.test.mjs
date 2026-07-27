import { test } from "node:test";
import assert from "node:assert/strict";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://pg1:pg1@localhost:5432/pg1";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;

const VALID_ENCRYPTION_KEY = "b".repeat(64); // 64 hex chars = 32 bytes
const ADMIN_SECRET = "test-admin-shared-secret";

const STANDARD_ERROR_KEYS = ["error", "message", "details", "request_id", "timestamp"];

function expectStandardError(response, status) {
	assert.equal(response.status, status);
	assert.deepEqual(
		Object.keys(response.body).sort(),
		STANDARD_ERROR_KEYS.toSorted(),
	);
	assert.equal(typeof response.body.error, "string");
	assert.equal(typeof response.body.message, "string");
	assert.equal(typeof response.body.request_id, "string");
}

/** Sets/deletes several env vars for the duration of `fn`, then restores them. */
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

test("listAdminRoutes exposes the required admin routes", async () => {
	const { listAdminRoutes } = await import("../src/admin-contract.mjs");
	const routes = listAdminRoutes().map((route) => `${route.method} ${route.path}`);
	assert.deepEqual(routes, [
		"GET /api/v1/admin/llm-providers",
		"POST /api/v1/admin/llm-providers",
		"PATCH /api/v1/admin/llm-providers/{id}",
		"POST /api/v1/admin/llm-providers/{id}/activate",
	]);
});

test("POST create without the x-admin-secret header is rejected with 401 and the standard error shape", async () => {
	const { handleAdminRequest } = await import("../src/admin-contract.mjs");
	await withEnv({ ADMIN_SHARED_SECRET: ADMIN_SECRET }, async () => {
		const response = await handleAdminRequest({
			method: "POST",
			path: "/api/v1/admin/llm-providers",
			body: {
				provider_name: "claude",
				model_id: "claude-sonnet-4-20250514",
				api_key: "sk-ant-should-never-appear",
			},
		});
		expectStandardError(response, 401);
		assert.doesNotMatch(JSON.stringify(response.body), /sk-ant-should-never-appear/);
	});
});

test("POST create with an incorrect x-admin-secret value is rejected with 403", async () => {
	const { handleAdminRequest } = await import("../src/admin-contract.mjs");
	await withEnv({ ADMIN_SHARED_SECRET: ADMIN_SECRET }, async () => {
		const response = await handleAdminRequest({
			method: "POST",
			path: "/api/v1/admin/llm-providers",
			headers: { "x-admin-secret": "wrong-secret" },
			body: {
				provider_name: "claude",
				model_id: "claude-sonnet-4-20250514",
				api_key: "sk-ant-should-never-appear",
			},
		});
		expectStandardError(response, 403);
		assert.doesNotMatch(JSON.stringify(response.body), /sk-ant-should-never-appear/);
	});
});

test("POST create with an unsupported provider_name is rejected with 422 and never echoes the submitted api_key", async () => {
	const { handleAdminRequest } = await import("../src/admin-contract.mjs");
	await withEnv({ ADMIN_SHARED_SECRET: ADMIN_SECRET }, async () => {
		const response = await handleAdminRequest({
			method: "POST",
			path: "/api/v1/admin/llm-providers",
			headers: { "x-admin-secret": ADMIN_SECRET },
			body: {
				provider_name: "openai",
				model_id: "gpt-4o",
				api_key: "sk-openai-must-never-leak-999",
			},
		});
		expectStandardError(response, 422);
		assert.equal(response.body.error, "validation_error");
		assert.ok(
			response.body.details.issues.some((issue) => issue.field === "provider_name"),
			"the 422 response must name provider_name as the invalid field",
		);
		assert.doesNotMatch(
			JSON.stringify(response.body),
			/sk-openai-must-never-leak-999/,
			"an invalid-provider-name failure must never echo the submitted api_key anywhere in the response",
		);
	});
});

test("creating a provider config fails fast with a clear error (never a raw key leak) when the encryption key is misconfigured", async () => {
	const { handleAdminRequest, _resetAdminContractForTests } = await import(
		"../src/admin-contract.mjs"
	);
	await withEnv(
		{
			ADMIN_SHARED_SECRET: ADMIN_SECRET,
			// Any non-empty connection string is enough to reach the repository
			// construction step — no real connection is ever attempted, because
			// the encryption-key fail-fast check happens before any DB I/O.
			DATABASE_URL: "postgres://fake:fake@localhost:1/fake",
			LLM_PROVIDER_ENCRYPTION_KEY: undefined,
		},
		async () => {
			_resetAdminContractForTests();
			const response = await handleAdminRequest({
				method: "POST",
				path: "/api/v1/admin/llm-providers",
				headers: { "x-admin-secret": ADMIN_SECRET },
				body: {
					provider_name: "claude",
					model_id: "claude-sonnet-4-20250514",
					api_key: "sk-ant-fail-fast-should-never-leak",
				},
			});
			assert.ok(response.status >= 500 && response.status < 600);
			assert.doesNotMatch(
				JSON.stringify(response.body),
				/sk-ant-fail-fast-should-never-leak/,
			);
			_resetAdminContractForTests();
		},
	);
});

test(
	"admin CRUD + activate against live Postgres: masked create, key-preserving update, atomic activate, and no encrypted_api_key ever in a response",
	async (t) => {
		let pg;
		let migrate;
		try {
			({ default: pg } = await import("pg"));
			migrate = await import("../src/db/migrate.mjs");
		} catch (error) {
			t.skip(`pg driver or migrate.mjs unavailable: ${error.message}`);
			return;
		}

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
			return;
		}

		try {
			await migrate.migrateDown({ client }).catch(() => {});
			await migrate.migrateUp({ client });
			await client.query("TRUNCATE TABLE llm_provider_config RESTART IDENTITY");
			await client.end();

			await withEnv(
				{
					ADMIN_SHARED_SECRET: ADMIN_SECRET,
					DATABASE_URL: databaseUrl,
					LLM_PROVIDER_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
				},
				async () => {
					const { handleAdminRequest, _resetAdminContractForTests } = await import(
						"../src/admin-contract.mjs"
					);
					_resetAdminContractForTests();
					const auth = { "x-admin-secret": ADMIN_SECRET };

					// --- Create: valid claude row -> 201, masked key only ---
					const createRes = await handleAdminRequest({
						method: "POST",
						path: "/api/v1/admin/llm-providers",
						headers: auth,
						body: {
							provider_name: "claude",
							model_id: "claude-sonnet-4-20250514",
							api_key: "sk-ant-original-secret-key-0001",
						},
					});
					assert.equal(createRes.status, 201);
					assert.equal(createRes.body.provider_name, "claude");
					assert.equal(createRes.body.api_key_last_four, "0001");
					assert.equal(createRes.body.is_active, false);
					assert.equal(createRes.body.encrypted_api_key, undefined);
					assert.equal(createRes.body.api_key, undefined);
					assert.doesNotMatch(
						JSON.stringify(createRes.body),
						/sk-ant-original-secret-key-0001/,
					);
					const claudeId = createRes.body.id;

					// --- Create a second (deepseek) row, inactive ---
					const createRes2 = await handleAdminRequest({
						method: "POST",
						path: "/api/v1/admin/llm-providers",
						headers: auth,
						body: {
							provider_name: "deepseek",
							model_id: "deepseek-chat",
							api_key: "sk-deepseek-secret-key-0002",
						},
					});
					assert.equal(createRes2.status, 201);
					const deepseekId = createRes2.body.id;

					// --- Update without resubmitting the key preserves the masked key ---
					const updateRes = await handleAdminRequest({
						method: "PATCH",
						path: `/api/v1/admin/llm-providers/${claudeId}`,
						headers: auth,
						body: { model_id: "claude-sonnet-4-5-20250929" },
					});
					assert.equal(updateRes.status, 200);
					assert.equal(updateRes.body.model_id, "claude-sonnet-4-5-20250929");
					assert.equal(
						updateRes.body.api_key_last_four,
						"0001",
						"a key-less update must preserve the previously stored masked key",
					);
					assert.equal(updateRes.body.encrypted_api_key, undefined);

					// --- Activate claude: becomes active ---
					const activateRes = await handleAdminRequest({
						method: "POST",
						path: `/api/v1/admin/llm-providers/${claudeId}/activate`,
						headers: auth,
					});
					assert.equal(activateRes.status, 200);
					assert.equal(activateRes.body.is_active, true);

					// --- Activate deepseek: atomically deactivates claude ---
					const activateRes2 = await handleAdminRequest({
						method: "POST",
						path: `/api/v1/admin/llm-providers/${deepseekId}/activate`,
						headers: auth,
					});
					assert.equal(activateRes2.status, 200);
					assert.equal(activateRes2.body.is_active, true);

					// --- List: exactly one active row (deepseek), never encrypted_api_key ---
					const listRes = await handleAdminRequest({
						method: "GET",
						path: "/api/v1/admin/llm-providers",
						headers: auth,
					});
					assert.equal(listRes.status, 200);
					assert.equal(listRes.body.items.length, 2);
					for (const item of listRes.body.items) {
						assert.equal(
							Object.prototype.hasOwnProperty.call(item, "encrypted_api_key"),
							false,
							"no list item may ever expose encrypted_api_key",
						);
						assert.equal(Object.prototype.hasOwnProperty.call(item, "api_key"), false);
					}
					const activeItems = listRes.body.items.filter((item) => item.is_active);
					assert.equal(activeItems.length, 1);
					assert.equal(activeItems[0].provider_name, "deepseek");
					const claudeItem = listRes.body.items.find((item) => item.id === claudeId);
					assert.equal(
						claudeItem.is_active,
						false,
						"activating deepseek must have atomically deactivated claude",
					);

					_resetAdminContractForTests();
				},
			);
		} finally {
			const cleanupClient = new pg.Client({ connectionString: databaseUrl });
			await cleanupClient.connect();
			await migrate.migrateDown({ client: cleanupClient }).catch(() => {});
			await cleanupClient.end();
		}
	},
);
