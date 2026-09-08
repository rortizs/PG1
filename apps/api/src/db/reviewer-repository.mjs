import { withClient } from "./migrate.mjs";

/**
 * `pg` returns BIGINT columns as strings; every id in this schema is
 * `GENERATED ALWAYS AS IDENTITY`, so values stay far below
 * `Number.MAX_SAFE_INTEGER` — coerce to a plain JS number, matching
 * `review-repository.mjs`/`provider-config-repository.mjs`'s own `toId`
 * convention.
 */
function toId(value) {
	return value === null || value === undefined ? value : Number(value);
}

function toReviewerRow(row) {
	return {
		id: toId(row.id),
		email: row.email,
		passwordHash: row.password_hash,
		displayName: row.display_name,
		isActive: row.is_active,
		failedLoginCount: row.failed_login_count,
		throttledUntil: row.throttled_until,
		lastLoginAt: row.last_login_at,
	};
}

/**
 * reviewer-authentication design.md D1/D3-D5/D10: `reviewer` +
 * `reviewer_session` persistence, mirroring
 * `provider-config-repository.mjs`'s shape (`createXRepository({ client,
 * connectionString })`, `withClient` for connection bookkeeping). Consumed
 * by `auth-contract.mjs`'s `verifyCredentials`/`checkSession` (via the
 * `repository` parameter's duck-typed interface) and `seed-reviewer.mjs`.
 */
export function createReviewerRepository({ client, connectionString } = {}) {
	const run = (fn) => withClient({ client, connectionString }, fn);

	return {
		async findByEmail(email) {
			return run(async (pgClient) => {
				const result = await pgClient.query(
					`SELECT id, email, password_hash, display_name, is_active,
					        failed_login_count, throttled_until, last_login_at
					 FROM reviewer WHERE email = $1`,
					[email],
				);
				if (result.rows.length === 0) return null;
				return toReviewerRow(result.rows[0]);
			});
		},

		async createReviewer({ email, passwordHash, displayName }) {
			return run(async (pgClient) => {
				const result = await pgClient.query(
					`INSERT INTO reviewer (email, password_hash, display_name)
					 VALUES ($1, $2, $3)
					 RETURNING id, email, display_name, is_active`,
					[email, passwordHash, displayName],
				);
				const row = result.rows[0];
				return {
					id: toId(row.id),
					email: row.email,
					displayName: row.display_name,
					isActive: row.is_active,
				};
			});
		},

		/**
		 * Persists the throttle/login-state fields `verifyCredentials` computes
		 * via `evaluateThrottle`/`nextThrottleState`. `lastLoginAt` is left
		 * untouched (`COALESCE`) when the caller does not pass one — i.e. on a
		 * failed attempt, only the throttle fields move.
		 */
		async updateLoginState(reviewerId, { failedLoginCount, throttledUntil, lastLoginAt }) {
			return run(async (pgClient) => {
				await pgClient.query(
					`UPDATE reviewer SET
					   failed_login_count = $2,
					   throttled_until = $3,
					   last_login_at = COALESCE($4, last_login_at),
					   updated_at = now()
					 WHERE id = $1`,
					[reviewerId, failedLoginCount, throttledUntil, lastLoginAt ?? null],
				);
			});
		},

		/** D10 `--reset-password`: replaces the hash and clears any throttle state. */
		async resetPassword(reviewerId, passwordHash) {
			return run(async (pgClient) => {
				await pgClient.query(
					`UPDATE reviewer SET
					   password_hash = $2,
					   failed_login_count = 0,
					   throttled_until = NULL,
					   updated_at = now()
					 WHERE id = $1`,
					[reviewerId, passwordHash],
				);
			});
		},

		/** D10 `--deactivate`: the only lever to kill a leaked credential without deleting audit history. */
		async setActive(reviewerId, isActive) {
			return run(async (pgClient) => {
				await pgClient.query(
					`UPDATE reviewer SET is_active = $2, updated_at = now() WHERE id = $1`,
					[reviewerId, isActive],
				);
			});
		},

		async createSession({ reviewerId, tokenHash, expiresAt }) {
			return run(async (pgClient) => {
				const result = await pgClient.query(
					`INSERT INTO reviewer_session (reviewer_id, token_hash, expires_at)
					 VALUES ($1, $2, $3)
					 RETURNING id`,
					[reviewerId, tokenHash, expiresAt],
				);
				return { id: toId(result.rows[0].id) };
			});
		},

		/**
		 * Joins the owning `reviewer` row so `checkSession()` can build its
		 * `{ reviewerId, sessionId, email, displayName, expiresAt }` shape from
		 * a single query.
		 */
		async findSessionByHash(tokenHash) {
			return run(async (pgClient) => {
				const result = await pgClient.query(
					`SELECT s.id AS session_id, s.reviewer_id, s.expires_at, s.revoked_at,
					        r.email, r.display_name
					 FROM reviewer_session s
					 JOIN reviewer r ON r.id = s.reviewer_id
					 WHERE s.token_hash = $1`,
					[tokenHash],
				);
				if (result.rows.length === 0) return null;
				const row = result.rows[0];
				return {
					sessionId: toId(row.session_id),
					reviewerId: toId(row.reviewer_id),
					expiresAt: row.expires_at,
					revokedAt: row.revoked_at,
					email: row.email,
					displayName: row.display_name,
				};
			});
		},

		/** Idempotent: revoking an already-revoked or unknown token_hash is a silent no-op (D7's logout contract relies on this). */
		async revokeSession(tokenHash) {
			return run(async (pgClient) => {
				await pgClient.query(
					`UPDATE reviewer_session SET revoked_at = now()
					 WHERE token_hash = $1 AND revoked_at IS NULL`,
					[tokenHash],
				);
			});
		},
	};
}
