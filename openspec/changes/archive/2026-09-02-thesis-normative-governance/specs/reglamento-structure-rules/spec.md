# Reglamento Structure Rules Specification

## Purpose

Text-checkable rules grounded in the library Reglamento de Tesis (Capítulo IV, Artículos 8, 30-37, 50): the required preliminary-page sequence and the verbatim Artículo 8° responsibility text. Scoped strictly to what is checkable from text-only PDF/DOCX extraction (`pypdf`/`python-docx`); no layout metadata is captured.

## Requirements

### Requirement: Preliminary Page Sequence Check

The system MUST flag when the required preliminary-page sequence is missing a page or out of order. The required order is: carátula exterior, carátula interior, hoja de autoridades y tribunal, autorización de impresión, hoja con el Reglamento (Artículo 8°), índice.

#### Scenario: Correct sequence produces no finding

- GIVEN a thesis document whose detected preliminary pages appear in the required order
- WHEN the Reglamento structure module evaluates the document
- THEN no preliminary-page-sequence finding is produced

#### Scenario: A missing or misordered page is flagged with evidence

- GIVEN a thesis document is missing the hoja de autoridades y tribunal or presents it out of order
- WHEN the Reglamento structure module evaluates the document
- THEN a finding is persisted with `normative_source_id` referencing `reglamento`
- AND `evidence_text` quotes the detected preliminary-page titles and order

### Requirement: Verbatim Artículo 8° Text Check

The system MUST flag when the required verbatim Artículo 8° "Responsabilidad" text is missing or altered: "Solamente el autor es responsable de los conceptos expresados en el trabajo de tesis. Su aprobación en manera alguna implica responsabilidad para la Universidad."

#### Scenario: Verbatim text is present and unaltered

- GIVEN the thesis document contains the exact required Artículo 8° text
- WHEN the Reglamento structure module evaluates the document
- THEN no Artículo 8° finding is produced

#### Scenario: Verbatim text is missing or altered

- GIVEN the thesis document omits the Artículo 8° text or presents an altered version
- WHEN the Reglamento structure module evaluates the document
- THEN a finding is persisted with `normative_source_id` referencing `reglamento`
- AND `evidence_text` contains the literal text found (or notes its absence)

### Requirement: Physical-Layout Non-Goal

This capability MUST NOT claim to evaluate physical-layout requirements from the Reglamento (margins, line spacing, font, pagination position, hanging indent, italics) or portada/contraportada visual fidelity (escudo dimensions, cartulina color). These remain unchecked until a layout-aware extraction pipeline exists.

#### Scenario: A physical-layout requirement is not evaluated

- GIVEN a thesis document violates a Reglamento margin or pagination-position rule
- WHEN the Reglamento structure module evaluates the document
- THEN no finding is produced for that violation
- AND no report claims physical-layout compliance was checked
