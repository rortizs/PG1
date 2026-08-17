"""Deterministic rule engine entrypoint (design.md D8,
precise-thesis-review-pipeline Work Units 4-5).

Zero LLM calls, structurally: this package and every module in it MUST NOT
import anything from `app.providers` — enforced by
`tests/test_rules.py::ImportBoundaryTest`, which parses every module's
imports with `ast` and fails hard if any of them reference a provider
module. `/internal/rules` (main.py) is the only HTTP caller.
"""
from __future__ import annotations

from . import citations, filler_words, gt_structure, long_sentences, spelling
from .base import MIN_RULE_CONFIDENCE, PRODUCER_ID, PRODUCER_TYPE, RuleFinding

_RULE_MODULES = (filler_words, long_sentences, spelling, citations, gt_structure)


def run_rules(pages: list[dict], sections: list[dict] | None = None) -> list[RuleFinding]:
    """Runs every deterministic rule module over already-extracted `pages`/
    `sections` (the same shape `/internal/extract` returns) and returns
    every candidate finding whose confidence meets `MIN_RULE_CONFIDENCE`
    (spec: Conservative Confidence Thresholds). Never raises for empty
    input — an empty `pages` list simply yields zero findings from every
    module."""
    sections = sections or []
    findings: list[RuleFinding] = []
    for module in _RULE_MODULES:
        for finding in module.check(pages, sections):
            if finding.confidence < MIN_RULE_CONFIDENCE:
                continue
            findings.append(finding)
    return findings


__all__ = [
    "MIN_RULE_CONFIDENCE",
    "PRODUCER_ID",
    "PRODUCER_TYPE",
    "RuleFinding",
    "run_rules",
]
