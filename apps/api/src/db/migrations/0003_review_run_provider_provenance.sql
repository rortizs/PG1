-- UP
ALTER TABLE review_run
  ADD COLUMN llm_provider_name TEXT
    CONSTRAINT review_run_llm_provider_name_check CHECK (llm_provider_name IS NULL OR llm_provider_name IN ('claude', 'deepseek', 'groq')),
  ADD COLUMN llm_model_id TEXT;

-- DOWN
ALTER TABLE review_run
  DROP COLUMN IF EXISTS llm_provider_name,
  DROP COLUMN IF EXISTS llm_model_id;
