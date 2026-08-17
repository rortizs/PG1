-- UP
CREATE UNIQUE INDEX idx_normative_segment_source_content_hash
  ON normative_segment (normative_source_id, (metadata->>'content_hash'));

CREATE UNIQUE INDEX idx_embedding_record_source_model_hash
  ON embedding_record (source_class, source_id, embedding_model, content_hash);

CREATE INDEX idx_embedding_record_embedding_cosine
  ON embedding_record USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1);

-- DOWN
DROP INDEX IF EXISTS idx_embedding_record_embedding_cosine;
DROP INDEX IF EXISTS idx_embedding_record_source_model_hash;
DROP INDEX IF EXISTS idx_normative_segment_source_content_hash;
