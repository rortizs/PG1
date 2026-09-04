-- UP
-- reviewer-authentication design.md D1: named reviewer accounts. `email` is stored
-- already-normalized (`normalizeEmail()` in auth-contract.mjs lowercases + trims); the CHECK
-- enforces that invariant in the schema, so no insert path (seed CLI, a future admin CRUD)
-- can create a case-variant duplicate identity that would silently split one human in two.
CREATE TABLE reviewer (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  password_hash TEXT NOT NULL CHECK (btrim(password_hash) <> ''),
  display_name TEXT NOT NULL CHECK (btrim(display_name) <> ''),
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- D5: throttle-only policy. `throttled_until` self-clears with wall time; there is no
  -- hard lock and no operator-intervention state, per the confirmed lockout decision.
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  throttled_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- D4: only the SHA-256 digest of the opaque token is ever stored. A dump of this table
-- yields no usable credential; the `~ '^[a-f0-9]{64}$'` CHECK mirrors
-- `thesis_document.sha256`'s existing convention and makes "someone stored the raw token"
-- structurally impossible rather than merely reviewed-against.
CREATE TABLE reviewer_session (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reviewer_id BIGINT NOT NULL REFERENCES reviewer(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reviewer_session_expiry_order_check CHECK (expires_at > created_at)
);

-- D8: unforgeable approval attribution. Nullable and never backfilled — historical rows keep
-- their free-text `reviewer_name` and a NULL id, which is the honest record of "approved
-- before identity existed" (confirmed: no backfill).
ALTER TABLE review_workflow_item
  ADD COLUMN approved_by_reviewer_id BIGINT REFERENCES reviewer(id);

CREATE INDEX idx_reviewer_session_reviewer_id ON reviewer_session(reviewer_id);
CREATE INDEX idx_reviewer_session_expires_at ON reviewer_session(expires_at);
CREATE INDEX idx_review_workflow_item_approved_by_reviewer_id
  ON review_workflow_item(approved_by_reviewer_id);

-- DOWN
-- Reverse order: the FK column referencing `reviewer` must go before `reviewer` itself,
-- and `reviewer_session` before `reviewer`, or the DROPs fail on dependent objects.
DROP INDEX IF EXISTS idx_review_workflow_item_approved_by_reviewer_id;
ALTER TABLE review_workflow_item DROP COLUMN IF EXISTS approved_by_reviewer_id;
DROP TABLE IF EXISTS reviewer_session;
DROP TABLE IF EXISTS reviewer;
