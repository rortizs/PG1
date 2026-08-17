"""Shared types and normalization helpers for the deterministic rule engine
(design.md D8). Deliberately dependency-free beyond the standard library —
`base.py` MUST NOT import anything from `app.providers` (see `__init__.py`'s
module docstring and `tests/test_rules.py::ImportBoundaryTest`).
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field

# design.md D8: "producer_type='deterministic_rule', producer_id='rules@v1',
# rule_id='<module>.<check>', MIN_RULE_CONFIDENCE = 0.70" — every rule module
# emits candidates against these fixed values; `run_rules()` is the single
# place that enforces the confidence gate (spec: Conservative Confidence
# Thresholds).
MIN_RULE_CONFIDENCE = 0.70
PRODUCER_TYPE = "deterministic_rule"
PRODUCER_ID = "rules@v1"


@dataclass(frozen=True)
class RuleFinding:
    """One candidate finding from a deterministic rule module. Mirrors the
    fields `review-orchestrator.mjs` needs to call `persistFinding` with —
    `page_number` resolves a real `document_page_id`, `section_index` is
    reserved for a future rule that can point at a specific detected
    section (unused by every PR2 rule module, always `None` today)."""

    finding_type: str
    severity: str
    confidence: float
    title: str
    explanation: str
    recommendation: str
    evidence_text: str
    page_number: int | None
    section_index: int | None
    rule_id: str
    metadata: dict = field(default_factory=dict)
    producer_type: str = PRODUCER_TYPE
    producer_id: str = PRODUCER_ID


def fold(text: str) -> str:
    """Accent-fold + case-fold + collapse whitespace — the same
    normalization `extraction.py`'s `_fold()` uses for heading detection,
    duplicated here (not imported) so `app/rules/` stays free of any
    cross-package coupling beyond the plain `pages`/`sections` dicts it
    receives as input."""
    normalized = unicodedata.normalize("NFKD", text)
    without_accents = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return " ".join(without_accents.casefold().split())
