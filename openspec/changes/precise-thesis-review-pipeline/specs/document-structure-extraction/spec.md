# Document Structure Extraction Specification

## Purpose

Detect real page and section boundaries for uploaded thesis documents so
every downstream finding can cite an exact page/section, and persist that
structure to `document_page`/`document_section`. PDF and DOCX MUST share one
canonical per-page extraction path: DOCX is converted to PDF via headless
LibreOffice first, then extracted through the same `pypdf` per-page logic
already used for native PDFs. No format may silently degrade to
section-only provenance.

## Requirements

### Requirement: PDF Per-Page Section Detection
The system MUST extract one `ExtractedPage` per physical PDF page and MUST
apply a heading-heuristic regex over each page's text to detect section
boundaries, populating `section_title` when a heading is matched.

#### Scenario: Heading pattern detected on a page
- GIVEN a PDF page whose text begins with a line matching the heading heuristic (e.g. "CAPÍTULO 3")
- WHEN extraction runs
- THEN the page's `section_title` is set to the matched heading text

#### Scenario: No heading pattern on a page
- GIVEN a PDF page with no line matching the heading heuristic
- WHEN extraction runs
- THEN `section_title` is `null` for that page and the page still carries a real `page_number`

### Requirement: DOCX-to-PDF Conversion for Page-Accurate Extraction
The system MUST convert every uploaded DOCX file to PDF via a headless
LibreOffice invocation before extraction, then run the identical per-page
`pypdf` extraction path used for native PDF uploads. DOCX MUST NOT use a
separate, page-less extraction path.

#### Scenario: DOCX upload produces real page numbers
- GIVEN a valid DOCX thesis upload
- WHEN the review pipeline extracts document structure
- THEN the converted PDF is extracted page-by-page and every `document_page` row for that document has a non-null `page_number`

#### Scenario: DOCX and PDF uploads share identical extraction behavior
- GIVEN one DOCX and one PDF upload with equivalent content and headings
- WHEN both are extracted
- THEN both produce comparable per-page `document_page`/`document_section` structures via the same extraction code path

### Requirement: LibreOffice Availability Fail-Loud Behavior
If the LibreOffice headless binary required for DOCX→PDF conversion is
missing or the conversion process crashes, the system MUST fail the
extraction step explicitly and MUST NOT fall back to section-only or
page-less provenance for that document.

#### Scenario: LibreOffice binary is not installed
- GIVEN a DOCX upload is submitted for review and the LibreOffice binary is not present on the worker host
- WHEN the review run attempts extraction
- THEN the `review_run` transitions to `status: "failed"` with an `error_summary` naming the missing LibreOffice dependency
- AND no `document_page` or `document_section` rows are persisted for that run
- AND no finding is fabricated to compensate

#### Scenario: LibreOffice conversion process crashes
- GIVEN a DOCX upload triggers a LibreOffice conversion that exits with a non-zero status or times out
- WHEN the review run processes that document
- THEN the `review_run` transitions to `status: "failed"` with a populated `error_summary`
- AND the failure is never silently swallowed into a completed run with degraded provenance

### Requirement: Explicit Uncertainty Flagging for Genuine Edge Cases
When section-boundary detection genuinely cannot determine a heading with
confidence (e.g. ambiguous formatting, OCR artifacts), the system MUST
persist the page/section with an explicit uncertainty flag rather than
guessing or omitting the row.

#### Scenario: Ambiguous heading text is flagged, not guessed
- GIVEN a page's text has a line that partially matches the heading heuristic but is ambiguous
- WHEN extraction runs
- THEN the resulting `document_section` (or page) row is persisted with its uncertainty flag set to true
- AND the row is not silently dropped

### Requirement: Structural Persistence to document_page and document_section
The system MUST persist every extracted page as a `document_page` row and
every detected section as a `document_section` row, both linked to the
source `thesis_document`, via new `insertDocumentPages`/
`insertDocumentSections` repository functions.

#### Scenario: Successful extraction persists full page structure
- GIVEN a document with N physical pages completes extraction successfully
- WHEN extraction finishes
- THEN exactly N `document_page` rows exist for that document, each with a real `page_number`

#### Scenario: Detected sections link back to their pages
- GIVEN extraction detects M section boundaries across a document's pages
- WHEN sections are persisted
- THEN M `document_section` rows exist, each referencing the `document_page` it starts on
