-- UP
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE thesis_document (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id UUID UNIQUE,
  original_filename TEXT NOT NULL CHECK (btrim(original_filename) <> ''),
  content_type TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
  storage_key TEXT NOT NULL UNIQUE CHECK (btrim(storage_key) <> ''),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  upload_status TEXT NOT NULL CONSTRAINT thesis_document_upload_status_check CHECK (upload_status IN ('uploaded', 'rejected', 'processing_disabled')),
  uploaded_by_user_id BIGINT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE review_run (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thesis_document_id BIGINT NOT NULL REFERENCES thesis_document(id),
  status TEXT NOT NULL CONSTRAINT review_run_status_check CHECK (status IN ('queued', 'extracting', 'segmenting', 'validating', 'rag_reviewing', 'reporting', 'completed', 'failed', 'cancelled')),
  pipeline_version TEXT NOT NULL CHECK (btrim(pipeline_version) <> ''),
  requested_outputs TEXT[] NOT NULL DEFAULT ARRAY['markdown'],
  error_summary TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_page (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thesis_document_id BIGINT NOT NULL REFERENCES thesis_document(id),
  review_run_id BIGINT NOT NULL REFERENCES review_run(id),
  page_number BIGINT CHECK (page_number IS NULL OR page_number > 0),
  text_content TEXT NOT NULL,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('pdf_text', 'docx', 'ocr')),
  provenance_confidence DOUBLE PRECISION CHECK (provenance_confidence IS NULL OR (provenance_confidence >= 0 AND provenance_confidence <= 1)),
  is_page_number_uncertain BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_section (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_run_id BIGINT NOT NULL REFERENCES review_run(id),
  parent_section_id BIGINT REFERENCES document_section(id),
  section_type TEXT NOT NULL CHECK (section_type IN ('chapter', 'section', 'subsection', 'references', 'appendix', 'unknown')),
  title TEXT,
  normalized_title TEXT,
  start_page_number BIGINT CHECK (start_page_number IS NULL OR start_page_number > 0),
  end_page_number BIGINT CHECK (end_page_number IS NULL OR end_page_number > 0),
  start_offset BIGINT CHECK (start_offset IS NULL OR start_offset >= 0),
  end_offset BIGINT CHECK (end_offset IS NULL OR end_offset >= 0),
  is_location_uncertain BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_section_page_order_check CHECK (end_page_number IS NULL OR start_page_number IS NULL OR end_page_number >= start_page_number),
  CONSTRAINT document_section_offset_order_check CHECK (end_offset IS NULL OR start_offset IS NULL OR end_offset >= start_offset)
);

CREATE TABLE evidence_snippet (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_run_id BIGINT NOT NULL REFERENCES review_run(id),
  document_page_id BIGINT REFERENCES document_page(id),
  document_section_id BIGINT REFERENCES document_section(id),
  evidence_text TEXT NOT NULL CHECK (btrim(evidence_text) <> ''),
  context_before TEXT,
  context_after TEXT,
  page_number BIGINT CHECK (page_number IS NULL OR page_number > 0),
  chapter_or_section_title TEXT,
  start_offset BIGINT CHECK (start_offset IS NULL OR start_offset >= 0),
  end_offset BIGINT CHECK (end_offset IS NULL OR end_offset >= 0),
  is_page_uncertain BOOLEAN NOT NULL DEFAULT false,
  is_section_uncertain BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evidence_snippet_location_check CHECK (page_number IS NOT NULL OR document_page_id IS NOT NULL OR document_section_id IS NOT NULL OR is_page_uncertain OR is_section_uncertain),
  CONSTRAINT evidence_snippet_offset_order_check CHECK (end_offset IS NULL OR start_offset IS NULL OR end_offset >= start_offset)
);

CREATE TABLE normative_source (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('gt_guide', 'apa_6', 'rubric', 'example_observation')),
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  version_label TEXT,
  storage_key TEXT,
  is_approved BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE finding (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_run_id BIGINT NOT NULL REFERENCES review_run(id),
  finding_type TEXT NOT NULL CHECK (finding_type IN ('gt', 'apa', 'writing_style', 'grammar', 'congruence', 'methodology', 'rag_review')),
  finding_subtype TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  explanation TEXT NOT NULL CHECK (btrim(explanation) <> ''),
  recommendation TEXT,
  producer_type TEXT NOT NULL CHECK (producer_type IN ('deterministic_rule', 'ai_assisted', 'controlled_rag', 'agentic_rag')),
  producer_id TEXT NOT NULL CHECK (btrim(producer_id) <> ''),
  rule_id TEXT,
  normative_source_id BIGINT REFERENCES normative_source(id),
  status TEXT NOT NULL CONSTRAINT finding_status_check CHECK (status IN ('valid', 'rejected', 'quarantined', 'partial')),
  rejection_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE finding_evidence (
  finding_id BIGINT NOT NULL REFERENCES finding(id),
  evidence_snippet_id BIGINT NOT NULL REFERENCES evidence_snippet(id),
  role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'supporting', 'contrasting', 'normative_context')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (finding_id, evidence_snippet_id)
);

CREATE TABLE report_artifact (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_run_id BIGINT NOT NULL REFERENCES review_run(id),
  format TEXT NOT NULL CHECK (format IN ('markdown', 'docx', 'xlsx')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'generating', 'available', 'failed')),
  storage_key TEXT,
  content_type TEXT,
  file_size_bytes BIGINT CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  is_partial BOOLEAN NOT NULL DEFAULT false,
  generation_version TEXT NOT NULL CHECK (btrim(generation_version) <> ''),
  error_summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_at TIMESTAMPTZ
);

CREATE TABLE normative_segment (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  normative_source_id BIGINT NOT NULL REFERENCES normative_source(id),
  segment_text TEXT NOT NULL CHECK (btrim(segment_text) <> ''),
  section_title TEXT,
  page_number BIGINT CHECK (page_number IS NULL OR page_number > 0),
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE embedding_record (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_class TEXT NOT NULL CHECK (source_class IN ('normative_segment')),
  source_id BIGINT NOT NULL REFERENCES normative_segment(id),
  embedding_model TEXT NOT NULL CHECK (btrim(embedding_model) <> ''),
  embedding vector(1536) NOT NULL,
  content_hash TEXT NOT NULL CHECK (btrim(content_hash) <> ''),
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_event (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id BIGINT,
  entity_type TEXT NOT NULL CHECK (btrim(entity_type) <> ''),
  entity_id BIGINT,
  event_type TEXT NOT NULL CHECK (btrim(event_type) <> ''),
  message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_thesis_document_uploaded_by_user_id ON thesis_document(uploaded_by_user_id);
CREATE INDEX idx_thesis_document_created_at ON thesis_document(created_at);
CREATE INDEX idx_thesis_document_sha256 ON thesis_document(sha256);

CREATE INDEX idx_review_run_thesis_document_id ON review_run(thesis_document_id);
CREATE INDEX idx_review_run_status ON review_run(status);
CREATE INDEX idx_review_run_thesis_document_created_at ON review_run(thesis_document_id, created_at);

CREATE INDEX idx_document_page_thesis_document_id ON document_page(thesis_document_id);
CREATE INDEX idx_document_page_review_run_id ON document_page(review_run_id);
CREATE INDEX idx_document_page_review_run_page_number ON document_page(review_run_id, page_number);

CREATE INDEX idx_document_section_review_run_id ON document_section(review_run_id);
CREATE INDEX idx_document_section_parent_section_id ON document_section(parent_section_id);
CREATE INDEX idx_document_section_review_run_section_type ON document_section(review_run_id, section_type);
CREATE INDEX idx_document_section_review_run_start_page_number ON document_section(review_run_id, start_page_number);

CREATE INDEX idx_evidence_snippet_review_run_id ON evidence_snippet(review_run_id);
CREATE INDEX idx_evidence_snippet_document_page_id ON evidence_snippet(document_page_id);
CREATE INDEX idx_evidence_snippet_document_section_id ON evidence_snippet(document_section_id);

CREATE INDEX idx_finding_review_run_id ON finding(review_run_id);
CREATE INDEX idx_finding_review_run_finding_type ON finding(review_run_id, finding_type);
CREATE INDEX idx_finding_review_run_severity ON finding(review_run_id, severity);
CREATE INDEX idx_finding_normative_source_id ON finding(normative_source_id);

CREATE INDEX idx_finding_evidence_evidence_snippet_id ON finding_evidence(evidence_snippet_id);

CREATE INDEX idx_report_artifact_review_run_id ON report_artifact(review_run_id);
CREATE INDEX idx_report_artifact_review_run_format ON report_artifact(review_run_id, format);

CREATE INDEX idx_normative_source_source_type_is_approved ON normative_source(source_type, is_approved);
CREATE INDEX idx_normative_segment_normative_source_id ON normative_segment(normative_source_id);

CREATE INDEX idx_embedding_record_source_class_source_id ON embedding_record(source_class, source_id);

CREATE INDEX idx_audit_event_entity_type_entity_id ON audit_event(entity_type, entity_id);
CREATE INDEX idx_audit_event_actor_user_id ON audit_event(actor_user_id);
CREATE INDEX idx_audit_event_created_at ON audit_event(created_at);

-- DOWN
DROP TABLE IF EXISTS audit_event;
DROP TABLE IF EXISTS embedding_record;
DROP TABLE IF EXISTS normative_segment;
DROP TABLE IF EXISTS report_artifact;
DROP TABLE IF EXISTS finding_evidence;
DROP TABLE IF EXISTS finding;
DROP TABLE IF EXISTS normative_source;
DROP TABLE IF EXISTS evidence_snippet;
DROP TABLE IF EXISTS document_section;
DROP TABLE IF EXISTS document_page;
DROP TABLE IF EXISTS review_run;
DROP TABLE IF EXISTS thesis_document;
DROP EXTENSION IF EXISTS vector;
