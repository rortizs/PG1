import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * thesis-normative-governance PR1 "governance spine", Work Unit 6
 * (design.md D9): "zero code path introduced by this change may read or
 * write `review_workflow_item.approval_state`" — proven structurally, not
 * by convention. `review_workflow_item` lives inside the same
 * `review-repository.mjs` module as `persistFinding`, so "zero imports of a
 * workflow repository" is not an available proof; this is proof #1 of 2
 * (the migration-text half). Proof #2 (call-path) lives in
 * `review-orchestrator.test.mjs`.
 */

const migrationUrl = new URL(
	"../src/db/migrations/0006_normative_governance.sql",
	import.meta.url,
);

function scanForApprovalGateReferences(sql) {
	return /review_workflow_item|approval_state/i.test(sql);
}

test("scanForApprovalGateReferences correctly detects a deliberate violation fixture (proves the scanner is not a no-op)", () => {
	const violatingFixture = `
		-- UP
		ALTER TABLE review_workflow_item ADD COLUMN sneaky TEXT;
		-- DOWN
		ALTER TABLE review_workflow_item DROP COLUMN sneaky;
	`;
	assert.equal(scanForApprovalGateReferences(violatingFixture), true);

	const alsoViolatingFixture = `
		-- UP
		UPDATE finding SET approval_state = 'approved';
		-- DOWN
		SELECT 1;
	`;
	assert.equal(scanForApprovalGateReferences(alsoViolatingFixture), true);
});

test("0006_normative_governance.sql names only normative_source and finding — never review_workflow_item or approval_state", async () => {
	const sql = await readFile(migrationUrl, "utf8");

	assert.equal(
		scanForApprovalGateReferences(sql),
		false,
		"0006_normative_governance.sql must not reference review_workflow_item or approval_state",
	);
	// Positive control: the migration DOES touch these two tables — proving
	// the scan isn't vacuously true because the file is empty/unrelated.
	assert.match(sql, /normative_source/);
	assert.match(sql, /\bfinding\b/);
});
