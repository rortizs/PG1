-- UP
CREATE TABLE review_workflow_item (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thesis_document_id BIGINT NOT NULL UNIQUE REFERENCES thesis_document(id),
  review_run_id BIGINT REFERENCES review_run(id),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'urgent')),
  approval_state TEXT NOT NULL DEFAULT 'not_approved' CHECK (approval_state IN ('not_approved', 'approved')),
  reviewer_name TEXT,
  metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_review_workflow_item_review_run_id ON review_workflow_item(review_run_id);
CREATE INDEX idx_review_workflow_item_priority ON review_workflow_item(priority);
CREATE INDEX idx_review_workflow_item_approval_state ON review_workflow_item(approval_state);

-- DOWN
DROP TABLE IF EXISTS review_workflow_item;
