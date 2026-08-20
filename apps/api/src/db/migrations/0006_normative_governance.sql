-- UP
-- thesis-normative-governance design.md D1: widen `normative_source.source_type`
-- to add `'reglamento_tesis'` (the library Reglamento already exists in the
-- corpus, mis-typed `'rubric'` — this migration RETYPES that row, it does
-- not invent a new one).
ALTER TABLE normative_source DROP CONSTRAINT normative_source_source_type_check;
ALTER TABLE normative_source ADD CONSTRAINT normative_source_source_type_check
  CHECK (source_type IN ('gt_guide','apa_6','rubric','example_observation','reglamento_tesis'));

-- design.md D1: precedence is derived from source_type inside the schema
-- itself (GENERATED ALWAYS ... STORED), so the tier ordering cannot drift
-- from the source registry — no insert path (seedNormativeSources(), a
-- future admin CRUD) can forget to set it, because it is never settable.
-- INVARIANT: mirrors `app/rules/base.py`'s SOURCE_PRECEDENCE dict exactly;
-- `app/rules/` has no DB access, so this migration is the source of truth.
ALTER TABLE normative_source ADD COLUMN precedence INTEGER NOT NULL
  GENERATED ALWAYS AS (CASE source_type
    WHEN 'reglamento_tesis' THEN 1 WHEN 'apa_6' THEN 2 WHEN 'gt_guide' THEN 3 ELSE 99 END) STORED;

-- Retype the existing Reglamento corpus row (verified: contains
-- "REGLAMENTO DE TESIS", "Artículo 8°: RESPONSABILIDAD" verbatim). Does
-- NOT insert a new row.
UPDATE normative_source SET source_type = 'reglamento_tesis'
  WHERE title = 'lineamientos_ingenieria_sistemas.txt';

-- Seed a metadata-only `apa_6` row: `apa_6` is a legal CHECK value that
-- nothing has ever written (no APA corpus .txt file exists), so without
-- this seed the resolver would still resolve `apa_6` findings to `null`.
-- Idempotent: a second run of this migration (or a re-seed) inserts
-- nothing further.
INSERT INTO normative_source (source_type, title, version_label, is_approved, metadata)
SELECT 'apa_6', 'Manual de Normas APA (6a edición)', '6a edición', true,
       '{"seeded_by":"0006_normative_governance","corpus_file":null}'
WHERE NOT EXISTS (SELECT 1 FROM normative_source WHERE source_type = 'apa_6');

-- design.md D2: extend `finding_type` with a source-neutral `'structure'`
-- category (not a reuse of `'gt'`, which would falsely claim GT-guide
-- provenance for a Reglamento-grounded structural finding).
ALTER TABLE finding DROP CONSTRAINT finding_finding_type_check;
ALTER TABLE finding ADD CONSTRAINT finding_finding_type_check
  CHECK (finding_type IN ('gt', 'apa', 'writing_style', 'grammar', 'congruence', 'methodology',
                          'rag_review', 'structure'));

CREATE INDEX idx_normative_source_precedence ON normative_source(precedence);

-- DOWN
-- Reverse order: retype-and-delete BEFORE narrowing the CHECKs back, or
-- the narrower CHECK re-add fails against rows still carrying the wider
-- values.
DROP INDEX IF EXISTS idx_normative_source_precedence;

UPDATE normative_source SET source_type = 'rubric'
  WHERE title = 'lineamientos_ingenieria_sistemas.txt' AND source_type = 'reglamento_tesis';

DELETE FROM normative_source
  WHERE source_type = 'apa_6' AND metadata->>'seeded_by' = '0006_normative_governance';

ALTER TABLE finding DROP CONSTRAINT finding_finding_type_check;
ALTER TABLE finding ADD CONSTRAINT finding_finding_type_check
  CHECK (finding_type IN ('gt', 'apa', 'writing_style', 'grammar', 'congruence', 'methodology',
                          'rag_review'));

ALTER TABLE normative_source DROP COLUMN precedence;

ALTER TABLE normative_source DROP CONSTRAINT normative_source_source_type_check;
ALTER TABLE normative_source ADD CONSTRAINT normative_source_source_type_check
  CHECK (source_type IN ('gt_guide', 'apa_6', 'rubric', 'example_observation'));
