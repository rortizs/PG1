# Normative Source Governance Specification

## Purpose

Every deterministic rule finding declares which institutional source justified it, sources declare a precedence order, and conflicting findings arbitrate by precedence instead of both surviving silently. This is a new capability (not a delta) because the previously-scoped `deterministic-writing-rules` capability lives only inside the unarchived `precise-thesis-review-pipeline` change and cannot be modified yet.

## Requirements

### Requirement: Precedence-Ranked Normative Sources

Every `normative_source` row MUST carry an explicit `precedence` value. The library Reglamento source family MUST resolve to the highest priority tier (1), `apa_6` to tier 2, and `gt_guide` to tier 3.

#### Scenario: Reglamento outranks APA and the Facultad guide

- GIVEN normative sources of type `reglamento`, `apa_6`, and `gt_guide` exist
- WHEN their precedence values are compared
- THEN `reglamento` has precedence 1, `apa_6` has precedence 2, `gt_guide` has precedence 3

#### Scenario: A normative source without precedence is rejected

- GIVEN a new normative source is inserted without a `precedence` value
- WHEN the insert is attempted
- THEN the database rejects the row

### Requirement: Deterministic Finding Source Provenance

Every finding produced by the deterministic rule engine (`services/worker/app/rules/`) MUST carry a non-null `normative_source_id` identifying the normative source family that justified it.

#### Scenario: A citations.py finding resolves a real source id

- GIVEN the citation rule module flags a missing reference entry
- WHEN the finding is persisted
- THEN `finding.normative_source_id` references the `apa_6` normative source

#### Scenario: No deterministic finding persists with a null source

- GIVEN any deterministic rule module produces a finding
- WHEN the finding is persisted
- THEN `finding.normative_source_id` is never `null`

### Requirement: Precedence Tier Metadata

Every finding produced by the deterministic rule engine MUST record a `precedence_tier` value in its metadata matching its normative source's precedence.

#### Scenario: Metadata tier matches the source precedence

- GIVEN a finding is grounded in the `reglamento` source
- WHEN the finding is persisted
- THEN `finding.metadata.precedence_tier` equals `1`

### Requirement: Precedence Conflict Arbitration

When two findings share a `conflict_key` metadata value for the same concrete requirement, the system MUST keep only the finding with the lowest `precedence_tier` as active and MUST demote the others with a `superseded_by_higher_precedence` metadata note rather than dropping them.

#### Scenario: A lower-precedence finding is demoted

- GIVEN two findings share `conflict_key: "art8-text"`, one tier 1 and one tier 2
- WHEN conflict arbitration runs
- THEN the tier 1 finding remains active
- AND the tier 2 finding's metadata includes `superseded_by_higher_precedence`

#### Scenario: Findings without a shared conflict_key are unaffected

- GIVEN two findings have no shared `conflict_key`
- WHEN conflict arbitration runs
- THEN both findings remain active

### Requirement: Approval Gate Isolation

No code path introduced by this capability MAY read or write `review_workflow_item.approval_state`.

#### Scenario: Rule engine execution leaves approval state untouched

- GIVEN the deterministic rule engine and precedence arbitration run for a review
- WHEN execution completes
- THEN `review_workflow_item.approval_state` is unchanged from before the run

### Requirement: Literal Grounding Invariant

Every finding produced under this capability MUST include `evidence_text` containing a literal excerpt from the source document; no finding may be persisted without it.

#### Scenario: A finding without literal evidence is not persisted

- GIVEN a rule module would produce a finding with no matching literal text
- WHEN the module evaluates the document
- THEN no finding is persisted for that case
