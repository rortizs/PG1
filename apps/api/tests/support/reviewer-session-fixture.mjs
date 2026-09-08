import { hashPassword } from "../../src/security/password-hasher.mjs";
import { createReviewerRepository } from "../../src/db/reviewer-repository.mjs";
import { generateSessionToken } from "../../src/auth-contract.mjs";

/**
 * reviewer-authentication PR3a: shared test-only fixture. Every route
 * `handleApiRequest`/a real NestJS controller now serves sits behind the
 * deny-by-default `checkSession` gate (design.md D6) — this creates a real
 * `reviewer` + `reviewer_session` row directly via the repository layer
 * (bypassing the login endpoint's throttle/audit machinery, which is not
 * what these callers exercise) and returns ready-to-use request headers.
 *
 * Requires the schema to already be migrated to head (`reviewer`/
 * `reviewer_session` tables must exist) — callers are expected to run their
 * own `migrateDown`/`migrateUp` first, exactly like every other real-Postgres
 * test in this suite.
 */
export async function createAuthenticatedSession({
	connectionString,
	email = `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
	displayName = "Fixture Reviewer",
} = {}) {
	const repository = createReviewerRepository({ connectionString });
	const passwordHash = await hashPassword("fixture-password-never-used-123");
	const reviewer = await repository.createReviewer({
		email,
		passwordHash,
		displayName,
	});
	const { token, tokenHash, expiresAt } = generateSessionToken();
	await repository.createSession({
		reviewerId: reviewer.id,
		tokenHash,
		expiresAt,
	});
	return {
		reviewerId: reviewer.id,
		// reviewer-authentication Unit 4: callers now need the real display
		// name too, to assert against attribution written from the session
		// (not a request body field) — purely additive, no signature change.
		displayName,
		token,
		headers: { Authorization: `Bearer ${token}` },
	};
}
