-- UP
ALTER TABLE llm_provider_config
  ADD COLUMN role TEXT NOT NULL DEFAULT 'judgment'
    CONSTRAINT llm_provider_config_role_check CHECK (role IN ('judgment', 'triage'));

DROP INDEX uq_llm_provider_config_one_active;

CREATE UNIQUE INDEX uq_llm_provider_config_one_active_per_role
  ON llm_provider_config (role) WHERE is_active;
CREATE INDEX idx_llm_provider_config_role ON llm_provider_config(role);

-- DOWN
-- This intentionally fails loudly if both judgment and triage rows are active.
-- The old schema can represent only one globally-active provider; deactivate
-- the triage row (or any extra active role) before reverting this migration.
DROP INDEX IF EXISTS uq_llm_provider_config_one_active_per_role;
DROP INDEX IF EXISTS idx_llm_provider_config_role;

CREATE UNIQUE INDEX uq_llm_provider_config_one_active
  ON llm_provider_config (is_active) WHERE is_active;

ALTER TABLE llm_provider_config DROP COLUMN IF EXISTS role;
