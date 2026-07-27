-- UP
CREATE TABLE llm_provider_config (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_name TEXT NOT NULL CONSTRAINT llm_provider_config_provider_name_check CHECK (provider_name IN ('claude', 'deepseek', 'groq')),
  model_id TEXT NOT NULL CHECK (btrim(model_id) <> ''),
  encrypted_api_key TEXT NOT NULL,
  api_key_last_four TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_llm_provider_config_one_active ON llm_provider_config (is_active) WHERE is_active;
CREATE INDEX idx_llm_provider_config_provider_name ON llm_provider_config(provider_name);

-- DOWN
DROP TABLE IF EXISTS llm_provider_config;
