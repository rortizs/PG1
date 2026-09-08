-- UP
ALTER TABLE review_run
  ADD COLUMN triage_provider_name TEXT
    CONSTRAINT review_run_triage_provider_name_check CHECK (triage_provider_name IS NULL OR triage_provider_name IN ('claude', 'deepseek', 'groq')),
  ADD COLUMN triage_model_id TEXT;

-- DOWN
ALTER TABLE review_run
  DROP COLUMN IF EXISTS triage_provider_name,
  DROP COLUMN IF EXISTS triage_model_id;
