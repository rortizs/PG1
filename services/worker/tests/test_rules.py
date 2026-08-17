"""Deterministic rule engine tests (design.md D8, precise-thesis-review-pipeline
Work Unit 4).

Every case here proves genuinely zero-LLM-call behavior: `app.rules` and every
submodule under it MUST NOT import anything from `app.providers` — enforced
structurally by `ImportBoundaryTest` below, not just by convention.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from app.rules import MIN_RULE_CONFIDENCE, run_rules
from app.rules import (
    citations,
    filler_words,
    gt_structure,
    long_sentences,
    segmentation,
    spelling,
)
from app.rules.base import RuleFinding


def _page(page_number, text):
    return {"page_number": page_number, "section_title": None, "text": text}


class ImportBoundaryTest(unittest.TestCase):
    def test_rules_package_never_imports_providers(self):
        rules_dir = Path(__file__).resolve().parents[1] / "app" / "rules"
        py_files = sorted(rules_dir.glob("*.py"))
        self.assertGreaterEqual(
            len(py_files), 5, "rules package appears to be missing modules"
        )
        for path in py_files:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    self.assertNotIn(
                        "providers",
                        module,
                        f"{path.name} imports from a provider module: {module}",
                    )
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        self.assertNotIn(
                            "providers",
                            alias.name,
                            f"{path.name} imports a provider module: {alias.name}",
                        )


class FillerWordsTest(unittest.TestCase):
    def test_filler_word_found_produces_a_writing_style_finding(self):
        pages = [_page(1, "Es decir que el sistema, o sea, funciona correctamente.")]
        findings = filler_words.check(pages, [])
        self.assertTrue(
            any(f.rule_id == "filler_words.lexicon_match" for f in findings)
        )
        match = next(f for f in findings if "o sea" in f.evidence_text.lower())
        self.assertEqual(match.finding_type, "writing_style")
        self.assertEqual(match.producer_type, "deterministic_rule")
        self.assertGreaterEqual(match.confidence, MIN_RULE_CONFIDENCE)

    def test_clean_text_produces_no_filler_findings(self):
        pages = [_page(1, "El sistema procesa la información de manera eficiente.")]
        self.assertEqual(filler_words.check(pages, []), [])


class LongSentencesTest(unittest.TestCase):
    def test_long_sentence_flagged_with_full_sentence_as_evidence(self):
        long_sentence = " ".join(["palabra"] * 45) + "."
        pages = [_page(1, long_sentence)]
        findings = long_sentences.check(pages, [])
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].finding_type, "writing_style")
        self.assertIn("palabra", findings[0].evidence_text)

    def test_short_sentence_is_not_flagged(self):
        pages = [_page(1, "Esta es una oración corta y clara.")]
        self.assertEqual(long_sentences.check(pages, []), [])

    def test_abbreviation_does_not_cause_a_false_sentence_break(self):
        text = "El Dr. García explicó la teoría durante la defensa de tesis."
        sentences = segmentation.sentences(text)
        self.assertEqual(len(sentences), 1)
        self.assertIn("Dr. García", sentences[0])


class SpellingTest(unittest.TestCase):
    def test_misspelled_word_is_flagged_with_context(self):
        pages = [_page(1, "El resultadoo del experimento fue positivo.")]
        findings = spelling.check(pages, [])
        self.assertTrue(
            any("resultadoo" == f.metadata.get("token") for f in findings)
        )
        flagged = next(f for f in findings if f.metadata.get("token") == "resultadoo")
        self.assertIn("resultadoo", flagged.evidence_text)
        self.assertGreaterEqual(flagged.confidence, MIN_RULE_CONFIDENCE)

    def test_uppercase_acronym_and_digit_tokens_are_never_flagged(self):
        pages = [_page(1, "El proyecto XYZQ usa un código B2 en el año 2020.")]
        findings = spelling.check(pages, [])
        flagged_tokens = {f.metadata.get("token") for f in findings}
        self.assertNotIn("XYZQ", flagged_tokens)
        self.assertNotIn("B2", flagged_tokens)


class CitationsTest(unittest.TestCase):
    def test_in_text_citation_without_reference_entry_is_flagged(self):
        pages = [
            _page(1, "Según lo indicado (García, 2020), el sistema mejora la calidad."),
            _page(
                10,
                "Referencias\nPérez, J. (2019). Otro estudio relacionado. Editorial X.",
            ),
        ]
        sections = [
            {
                "index": 0,
                "section_type": "references",
                "start_page_number": 10,
                "end_page_number": 10,
            }
        ]
        findings = citations.check(pages, sections)
        uncited = [
            f for f in findings if f.rule_id == "citations.uncited_reference_missing"
        ]
        self.assertTrue(any("García" in f.evidence_text for f in uncited))

    def test_reference_entry_never_cited_is_flagged(self):
        pages = [
            _page(1, "Según lo indicado (Pérez, 2019), el sistema mejora la calidad."),
            _page(
                10,
                "Referencias\nGarcía, A. (2020). Estudio no citado. Editorial Y.",
            ),
        ]
        sections = [
            {
                "index": 0,
                "section_type": "references",
                "start_page_number": 10,
                "end_page_number": 10,
            }
        ]
        findings = citations.check(pages, sections)
        unused = [f for f in findings if f.rule_id == "citations.unused_reference_entry"]
        self.assertTrue(any("García" in f.evidence_text for f in unused))


class GtStructureTest(unittest.TestCase):
    def test_missing_required_section_is_flagged(self):
        sections = [
            {
                "index": 0,
                "title": "Introducción",
                "normalized_title": "introduccion",
                "section_type": "chapter",
            },
        ]
        findings = gt_structure.check([], sections)
        self.assertTrue(
            any(f.rule_id == "gt_structure.missing_required_section" for f in findings)
        )

    def test_zero_detected_sections_skips_the_check_entirely(self):
        self.assertEqual(gt_structure.check([], []), [])


class ConfidenceThresholdTest(unittest.TestCase):
    def test_below_threshold_candidate_is_discarded_by_run_rules(self):
        import app.rules as rules_module

        class FakeModule:
            @staticmethod
            def check(pages, sections):
                return [
                    RuleFinding(
                        finding_type="writing_style",
                        severity="low",
                        confidence=MIN_RULE_CONFIDENCE - 0.05,
                        title="Below threshold",
                        explanation="Should never persist.",
                        recommendation="N/A",
                        evidence_text="irrelevant",
                        page_number=1,
                        section_index=None,
                        rule_id="fake.below_threshold",
                        metadata={},
                    )
                ]

        original_modules = rules_module._RULE_MODULES
        rules_module._RULE_MODULES = (FakeModule(),)
        try:
            findings = run_rules([_page(1, "text")], [])
        finally:
            rules_module._RULE_MODULES = original_modules
        self.assertEqual(findings, [])


class RunRulesTest(unittest.TestCase):
    def test_run_rules_aggregates_every_module_and_tags_producer_fields(self):
        pages = [_page(1, "Es decir que el resultadoo fue bueno.")]
        findings = run_rules(pages, [])
        self.assertIsInstance(findings, list)
        self.assertTrue(len(findings) > 0)
        for finding in findings:
            self.assertIsInstance(finding, RuleFinding)
            self.assertEqual(finding.producer_type, "deterministic_rule")
            self.assertEqual(finding.producer_id, "rules@v1")
            self.assertGreaterEqual(finding.confidence, MIN_RULE_CONFIDENCE)

    def test_empty_pages_never_crashes(self):
        self.assertEqual(run_rules([], []), [])


if __name__ == "__main__":
    unittest.main()
