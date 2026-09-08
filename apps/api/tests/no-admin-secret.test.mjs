import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * reviewer-authentication PR3a (design.md D11, Scope Guard): the temporary
 * MVP admin shared-secret must appear in **zero** files under `apps/` and
 * `docs/` once this unit lands — proven directly, not by convention.
 *
 * First proves the scanner genuinely fails against a fixture string
 * containing `ADMIN_SHARED_SECRET` (so a bug that makes it a silent no-op
 * would itself be caught), then walks the real repository tree.
 */

const BANNED_IDENTIFIERS = [
	"ADMIN_SHARED_SECRET",
	"x-admin-secret",
	"checkAdminSecretHeader",
	"constantTimeEquals",
];

const REPO_ROOT = new URL("../../../", import.meta.url);
const SCAN_ROOTS = ["apps", "docs"];

const EXCLUDED_DIR_SEGMENTS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".pi-lens",
	".angular",
	"coverage",
]);

/**
 * Files this scanner deliberately does not flag, each with a concrete
 * reason (never a blanket exclusion):
 *
 * - This file itself: its own fixture string below must literally contain
 *   `ADMIN_SHARED_SECRET` to prove the scanner is not a no-op.
 * - `apps/web/tests/smoke.test.mjs`: owned by the parallel Unit 3b (zero
 *   file overlap with this unit) — it proves the *absence* of
 *   `x-admin-secret` in `admin-api-client.ts` via a `doesNotMatch(...,
 *   /x-admin-secret/)` regex assertion and an explanatory comment, both of
 *   which necessarily contain the literal substring to assert against. A
 *   text scanner cannot distinguish "asserting absence" from "leftover
 *   usage" without parsing intent; excluding this one specific, documented
 *   file is the honest alternative to a false failure.
 */
function isExcludedFile(relativePath) {
	return (
		relativePath === "apps/api/tests/no-admin-secret.test.mjs" ||
		relativePath === "apps/web/tests/smoke.test.mjs"
	);
}

async function listFilesRecursive(rootUrl) {
	const rootPath = fileURLToPath(rootUrl);
	let entries;
	try {
		entries = await readdir(rootPath, { withFileTypes: true, recursive: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile())
		.filter((entry) => {
			const segments = entry.parentPath
				? `${entry.parentPath}/${entry.name}`.split("/")
				: entry.name.split("/");
			return !segments.some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment));
		})
		.map((entry) =>
			entry.parentPath ? `${entry.parentPath}/${entry.name}` : entry.name,
		);
}

function toRepoRelativePath(absolutePath) {
	const repoRootPath = fileURLToPath(REPO_ROOT);
	return absolutePath.startsWith(repoRootPath)
		? absolutePath.slice(repoRootPath.length)
		: absolutePath;
}

function findOccurrences(content) {
	return BANNED_IDENTIFIERS.filter((identifier) => content.includes(identifier));
}

test("scanner sanity: the banned-identifier scan genuinely fails against a fixture string (not a no-op)", () => {
	const fixture = "export const ADMIN_SHARED_SECRET = process.env.ADMIN_SHARED_SECRET;";
	const occurrences = findOccurrences(fixture);
	assert.ok(
		occurrences.includes("ADMIN_SHARED_SECRET"),
		"the scanner must detect ADMIN_SHARED_SECRET in a fixture string that genuinely contains it",
	);
});

test("repo-wide: ADMIN_SHARED_SECRET / x-admin-secret / checkAdminSecretHeader / constantTimeEquals appear in zero files under apps/ and docs/", async () => {
	const violations = [];

	for (const scanRootName of SCAN_ROOTS) {
		const scanRootUrl = new URL(`${scanRootName}/`, REPO_ROOT);
		const absolutePaths = await listFilesRecursive(scanRootUrl);
		for (const absolutePath of absolutePaths) {
			const relativePath = toRepoRelativePath(absolutePath);
			if (isExcludedFile(relativePath)) continue;

			let content;
			try {
				content = await readFile(absolutePath, "utf8");
			} catch {
				continue; // binary/unreadable files (images, etc.) are not in scope
			}

			const found = findOccurrences(content);
			if (found.length > 0) {
				violations.push({ path: relativePath, found });
			}
		}
	}

	assert.deepEqual(
		violations,
		[],
		`the following files still reference a retired admin-secret identifier: ${JSON.stringify(violations, null, 2)}`,
	);
});
