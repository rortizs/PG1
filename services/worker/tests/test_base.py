"""Tests for `app/rules/base.py`'s shared provenance primitives
(thesis-normative-governance, PR1 "governance spine", design.md D3).

Covers: `RuleFinding.normative_source_type` defaulted construction,
`SOURCE_PRECEDENCE`'s exact tier mapping (mirrors migration
`0006_normative_governance.sql`'s generated `precedence` expression — see
that migration's comment for the invariant), and `squeeze()`'s
whitespace-immune normalization used by the (PR2) Reglamento module.
"""
from __future__ import annotations

import unittest
from dataclasses import replace

from app.rules.base import RuleFinding, SOURCE_PRECEDENCE, fold, squeeze


def _finding(**overrides):
    defaults = dict(
        finding_type="writing_style",
        severity="low",
        confidence=0.9,
        title="t",
        explanation="e",
        recommendation="r",
        evidence_text="ev",
        page_number=1,
        section_index=None,
        rule_id="fake.rule",
    )
    defaults.update(overrides)
    return RuleFinding(**defaults)


class RuleFindingNormativeSourceTypeTest(unittest.TestCase):
    def test_default_construction_leaves_normative_source_type_none(self):
        finding = _finding()
        self.assertIsNone(finding.normative_source_type)

    def test_normative_source_type_can_be_set_explicitly(self):
        finding = _finding(normative_source_type="gt_guide")
        self.assertEqual(finding.normative_source_type, "gt_guide")

    def test_rule_finding_stays_frozen_mutation_requires_dataclasses_replace(self):
        finding = _finding()
        with self.assertRaises(Exception):
            finding.normative_source_type = "apa_6"  # type: ignore[misc]
        stamped = replace(finding, normative_source_type="apa_6")
        self.assertEqual(stamped.normative_source_type, "apa_6")
        # The original is untouched — `replace()` returns a new instance.
        self.assertIsNone(finding.normative_source_type)


class SourcePrecedenceTest(unittest.TestCase):
    def test_source_precedence_matches_the_migration_generated_expression(self):
        self.assertEqual(
            SOURCE_PRECEDENCE,
            {"reglamento_tesis": 1, "apa_6": 2, "gt_guide": 3},
        )


class SqueezeTest(unittest.TestCase):
    def test_squeeze_matches_across_an_intra_word_split(self):
        self.assertEqual(squeeze("numeraci ón"), squeeze("numeración"))

    def test_squeeze_matches_across_a_line_wrap(self):
        self.assertEqual(squeeze("m ismas\nmarg en"), squeeze("mismas margen"))

    def test_squeeze_removes_all_whitespace_after_folding(self):
        self.assertEqual(squeeze("Á  B\tC"), "abc")

    def test_squeeze_delegates_case_and_accent_normalization_to_fold(self):
        # squeeze() must not duplicate fold()'s accent/case logic — both
        # helpers must agree once whitespace is stripped.
        text = "RESPONSABILIDAD Única"
        self.assertEqual(squeeze(text), fold(text).replace(" ", ""))


if __name__ == "__main__":
    unittest.main()
