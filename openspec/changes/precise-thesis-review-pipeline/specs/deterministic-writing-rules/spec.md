# Deterministic Writing Rules Specification

## Purpose

Provide a zero-LLM rule engine that produces `producer_type='deterministic_rule'`
findings for pattern-matchable writing-quality issues: filler words, long
sentences, Spanish spelling, citation-vs-reference consistency, and GT
structure presence. This path MUST run independently of the LLM review path
— a failure in either path MUST NOT affect the other's correctness or
persistence.

## Requirements

### Requirement: Filler Word Detection
The system MUST detect known Spanish filler words/phrases ("muletillas") via
a lexicon/regex match over extracted text, with zero LLM calls.

#### Scenario: Filler word found in a sentence
- GIVEN a page's extracted text contains a filler word from the configured lexicon
- WHEN the deterministic rule engine runs
- THEN a finding is produced with `producer_type: "deterministic_rule"` and `finding_type` reflecting the writing-style category
- AND its evidence quotes the literal filler-word occurrence

### Requirement: Long Sentence Detection via Real Sentence Segmentation
The system MUST segment text into sentences using a real Spanish sentence
segmenter (not naive `.`-splitting, which breaks on abbreviations), then
flag sentences exceeding a configured length threshold.

#### Scenario: Sentence exceeds the length threshold
- GIVEN a segmented sentence whose token/word count exceeds the configured threshold
- WHEN the rule engine evaluates it
- THEN a long-sentence finding is produced with the full sentence as evidence

#### Scenario: Abbreviation does not cause a false sentence break
- GIVEN a passage containing an abbreviation followed by a period (e.g. "Dr. García") within a single logical sentence
- WHEN sentence segmentation runs
- THEN the abbreviation is not treated as a sentence boundary and the sentence is evaluated as one unit

### Requirement: Spanish Spelling Check
The system MUST check extracted text against a Spanish dictionary and flag
words that are not recognized, with zero LLM calls.

#### Scenario: Misspelled word is flagged
- GIVEN extracted text contains a token absent from the configured Spanish dictionary and not an academic term exception
- WHEN the spelling check runs
- THEN a spelling finding is produced quoting the misspelled token and its surrounding context

### Requirement: Citation-vs-Reference Cross-Check
The system MUST extract in-text citations and reference-list entries via
regex, then flag citations with no matching reference-list entry and
reference-list entries never cited in the text.

#### Scenario: In-text citation has no matching reference entry
- GIVEN an in-text citation (e.g. "(García, 2020)") with no corresponding entry in the reference list
- WHEN the cross-check runs
- THEN a finding is produced identifying the uncited-in-references citation

#### Scenario: Reference entry is never cited
- GIVEN a reference-list entry with no matching in-text citation anywhere in the document
- WHEN the cross-check runs
- THEN a finding is produced identifying the unused reference entry

### Requirement: GT Structure Presence Check
The system MUST compare detected section headings against the expected
structure defined in the GT normative documents and flag missing required
sections.

#### Scenario: Required section is missing
- GIVEN detected `document_section` headings for a thesis do not include a section required by the GT structure list
- WHEN the structure check runs
- THEN a finding is produced naming the missing required section

### Requirement: Conservative Confidence Thresholds
Every deterministic rule MUST assign a confidence score to its findings, and
findings below a conservative minimum confidence threshold MUST NOT be
persisted, biasing toward fewer false positives over exhaustive recall.

#### Scenario: Low-confidence heuristic match is discarded
- GIVEN a rule match whose computed confidence falls below the configured minimum threshold
- WHEN the rule engine finalizes its findings
- THEN that candidate finding is discarded and never persisted

### Requirement: Independence from the LLM Review Path
The deterministic rule engine MUST run and persist its findings without any
dependency on the LLM provider path succeeding, and vice versa.

#### Scenario: LLM provider call fails but deterministic findings still persist
- GIVEN the LLM review call for a run fails (e.g. no active judgment provider, upstream timeout)
- WHEN the deterministic rule engine has already produced findings for that document
- THEN those deterministic findings are persisted with `producer_type: "deterministic_rule"` regardless of the LLM path's failure

#### Scenario: Deterministic rule engine failure does not block LLM findings
- GIVEN the deterministic rule engine raises an unexpected error while processing a document
- WHEN the LLM review path completes successfully for the same run
- THEN the LLM-produced findings are still persisted correctly
