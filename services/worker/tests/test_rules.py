"""Deterministic rule engine tests (design.md D8, precise-thesis-review-pipeline
Work Unit 4).

Every case here proves genuinely zero-LLM-call behavior: `app.rules` and every
submodule under it MUST NOT import anything from `app.providers` — enforced
structurally by `ImportBoundaryTest` below, not just by convention.
"""
from __future__ import annotations

import ast
import difflib
import re
import unittest
from dataclasses import replace
from pathlib import Path

from app.rules import MIN_RULE_CONFIDENCE, run_rules
from app.rules import (
    citations,
    filler_words,
    gt_structure,
    long_sentences,
    reglamento_structure,
    segmentation,
    spelling,
)
from app.rules.base import RuleFinding, SOURCE_PRECEDENCE, fold


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
            # thesis-normative-governance design.md D3: run_rules() now
            # reads this constant via getattr() BEFORE filtering by
            # confidence, so any fixture module exercised by run_rules()
            # must declare it (a real, currently-registered source type) or
            # it fails on the unrelated AttributeError this test is not
            # about — see `NormativeSourceStampingTest` below for the
            # dedicated missing-constant coverage.
            NORMATIVE_SOURCE_TYPE = "gt_guide"

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


class NormativeSourceStampingTest(unittest.TestCase):
    """thesis-normative-governance design.md D3: `run_rules()` is the single
    choke point that stamps `normative_source_type`/`metadata.precedence_tier`
    onto every finding, reading each module's declared
    `NORMATIVE_SOURCE_TYPE` constant. Before this pass, nothing stamps the
    field (`None`, today's real pre-change behavior) and a fixture module
    lacking the constant has nothing to raise at all — this is the loud,
    not-silent-`None` behavior design.md D3 specifically calls for."""

    def test_a_filler_words_finding_is_stamped_gt_guide_tier_three(self):
        pages = [_page(1, "Es decir que el sistema, o sea, funciona bien.")]
        findings = run_rules(pages, [])
        filler_finding = next(
            f for f in findings if f.rule_id == "filler_words.lexicon_match"
        )
        self.assertEqual(filler_finding.normative_source_type, "gt_guide")
        self.assertEqual(filler_finding.metadata.get("precedence_tier"), 3)

    def test_every_registered_module_declares_normative_source_type(self):
        import app.rules as rules_module

        for module in rules_module._RULE_MODULES:
            self.assertTrue(
                hasattr(module, "NORMATIVE_SOURCE_TYPE"),
                f"{module} is registered in _RULE_MODULES but declares no "
                "NORMATIVE_SOURCE_TYPE constant",
            )
            self.assertIn(
                module.NORMATIVE_SOURCE_TYPE,
                SOURCE_PRECEDENCE,
                f"{module}.NORMATIVE_SOURCE_TYPE is not a recognized tier",
            )

    def test_a_module_missing_the_constant_raises_loudly_not_silently(self):
        import app.rules as rules_module

        class FakeModuleMissingConstant:
            @staticmethod
            def check(pages, sections):
                return [
                    RuleFinding(
                        finding_type="writing_style",
                        severity="low",
                        confidence=0.9,
                        title="whatever",
                        explanation="whatever",
                        recommendation="whatever",
                        evidence_text="whatever",
                        page_number=1,
                        section_index=None,
                        rule_id="fake.no_source_type",
                        metadata={},
                    )
                ]

        original_modules = rules_module._RULE_MODULES
        rules_module._RULE_MODULES = (FakeModuleMissingConstant(),)
        try:
            with self.assertRaises(AttributeError):
                run_rules([_page(1, "text")], [])
        finally:
            rules_module._RULE_MODULES = original_modules

    def test_a_module_with_an_unrecognized_source_type_raises_key_error(self):
        import app.rules as rules_module

        class FakeModuleUnknownSourceType:
            NORMATIVE_SOURCE_TYPE = "not_a_real_source_type"

            @staticmethod
            def check(pages, sections):
                return [
                    RuleFinding(
                        finding_type="writing_style",
                        severity="low",
                        confidence=0.9,
                        title="whatever",
                        explanation="whatever",
                        recommendation="whatever",
                        evidence_text="whatever",
                        page_number=1,
                        section_index=None,
                        rule_id="fake.unknown_source_type",
                        metadata={},
                    )
                ]

        original_modules = rules_module._RULE_MODULES
        rules_module._RULE_MODULES = (FakeModuleUnknownSourceType(),)
        try:
            with self.assertRaises(KeyError):
                run_rules([_page(1, "text")], [])
        finally:
            rules_module._RULE_MODULES = original_modules


class Apa6EtAlThresholdTest(unittest.TestCase):
    """thesis-normative-governance design.md D6, spec: APA 6 Citation Rules
    — Et-al. Threshold Enforcement. A second, independent scanner over
    `citations.py`'s pages — the existing uncited/unused cross-check
    (`CitationsTest` above) is untouched."""

    def test_two_authors_named_on_every_mention_produces_no_finding(self):
        pages = [
            _page(1, "Como indican (García & Pérez, 2020), el sistema mejora."),
            _page(2, "Posteriormente, (García & Pérez, 2020) reafirman su postura."),
        ]
        findings = citations.check(pages, [])
        et_al_findings = [f for f in findings if "et_al" in f.rule_id]
        self.assertEqual(et_al_findings, [])

    def test_four_authors_full_on_first_mention_et_al_on_second_produces_no_finding(self):
        pages = [
            _page(
                1,
                "Según (García, Pérez, López & Fuentes, 2020), el sistema mejora.",
            ),
            _page(2, "Más adelante, (García et al., 2020) lo confirman."),
        ]
        findings = citations.check(pages, [])
        et_al_findings = [f for f in findings if "et_al" in f.rule_id]
        self.assertEqual(et_al_findings, [])

    def test_four_authors_full_on_a_second_mention_is_flagged(self):
        pages = [
            _page(
                1,
                "Según (García, Pérez, López & Fuentes, 2020), el sistema mejora.",
            ),
            _page(
                2,
                "Nuevamente, (García, Pérez, López & Fuentes, 2020) lo confirman.",
            ),
        ]
        findings = citations.check(pages, [])
        flagged = [
            f
            for f in findings
            if f.rule_id == citations.ET_AL_REQUIRED_AFTER_FIRST_MENTION_RULE_ID
        ]
        self.assertEqual(len(flagged), 1)
        self.assertIn("García", flagged[0].evidence_text)
        self.assertEqual(flagged[0].page_number, 2)

    def test_seven_authors_fully_named_on_first_mention_is_flagged(self):
        pages = [
            _page(
                1,
                "Según (García, Pérez, López, Fuentes, Ramírez, Castillo & "
                "Morales, 2020), el sistema mejora la calidad.",
            )
        ]
        findings = citations.check(pages, [])
        flagged = [
            f for f in findings if f.rule_id == citations.ET_AL_REQUIRED_SIX_AUTHORS_RULE_ID
        ]
        self.assertEqual(len(flagged), 1)
        self.assertIn("García", flagged[0].evidence_text)
        self.assertGreaterEqual(flagged[0].confidence, MIN_RULE_CONFIDENCE)

    def test_correct_et_al_usage_for_six_plus_authors_produces_no_finding(self):
        pages = [_page(1, "Según (García et al., 2020), el sistema mejora.")]
        findings = citations.check(pages, [])
        flagged = [
            f for f in findings if f.rule_id == citations.ET_AL_REQUIRED_SIX_AUTHORS_RULE_ID
        ]
        self.assertEqual(flagged, [])

    def test_et_al_citation_whose_reference_names_exactly_two_authors_is_flagged(self):
        pages = [
            _page(1, "Como señalan (García et al., 2020), el sistema mejora."),
            _page(
                10,
                "Referencias\nGarcía, A., & Pérez, B. (2020). Estudio con dos "
                "autores. Editorial Z.",
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
        flagged = [
            f for f in findings if f.rule_id == citations.ET_AL_ON_TWO_AUTHOR_SOURCE_RULE_ID
        ]
        self.assertEqual(len(flagged), 1)
        self.assertIn("García et al", flagged[0].evidence_text)

    def test_et_al_citation_whose_reference_names_three_authors_is_not_flagged(self):
        pages = [
            _page(1, "Como señalan (García et al., 2020), el sistema mejora."),
            _page(
                10,
                "Referencias\nGarcía, A., Pérez, B., & López, C. (2020). Estudio "
                "con tres autores. Editorial Z.",
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
        flagged = [
            f for f in findings if f.rule_id == citations.ET_AL_ON_TWO_AUTHOR_SOURCE_RULE_ID
        ]
        self.assertEqual(flagged, [])

    def test_et_al_citation_with_no_resolvable_reference_entry_is_not_flagged(self):
        # design.md D6: "only when the reference entry resolves" -- an
        # unresolved et al. citation is not checkable, never fabricated.
        pages = [_page(1, "Como señalan (García et al., 2020), el sistema mejora.")]
        findings = citations.check(pages, [])
        flagged = [
            f for f in findings if f.rule_id == citations.ET_AL_ON_TWO_AUTHOR_SOURCE_RULE_ID
        ]
        self.assertEqual(flagged, [])

    def test_pre_existing_cross_check_fixtures_remain_unaffected_by_the_new_scanner(self):
        # Regression guard (design.md D6): the new et-al scanner must not
        # change the pre-existing uncited/unused cross-check's output for
        # the same fixtures CitationsTest already exercises.
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
        et_al_findings = [f for f in findings if "et_al" in f.rule_id]
        self.assertEqual(et_al_findings, [])


class Apa6QuoteLengthTest(unittest.TestCase):
    """thesis-normative-governance design.md D6, spec: APA 6 Citation Rules
    — Quote-Length Formatting Rule."""

    def test_short_inline_quote_under_forty_words_produces_no_finding(self):
        quote = " ".join(["palabra"] * 25)
        pages = [_page(1, f'El autor señala que "{quote}" en su análisis.')]
        findings = citations.check(pages, [])
        flagged = [f for f in findings if f.rule_id == citations.LONG_QUOTE_NOT_BLOCK_RULE_ID]
        self.assertEqual(flagged, [])

    def test_fifty_five_word_inline_quote_is_flagged(self):
        quote = " ".join(["palabra"] * 55)
        pages = [_page(1, f'El autor señala que "{quote}" en su análisis.')]
        findings = citations.check(pages, [])
        flagged = [f for f in findings if f.rule_id == citations.LONG_QUOTE_NOT_BLOCK_RULE_ID]
        self.assertEqual(len(flagged), 1)
        self.assertIn("palabra", flagged[0].evidence_text)
        self.assertEqual(flagged[0].metadata.get("word_count"), 55)

    def test_unterminated_quotation_mark_never_hangs_or_swallows_the_page(self):
        # ReDoS guard (design.md D6, threat matrix): an unmatched quote mark
        # must not hang the regex engine or swallow the rest of the page.
        long_tail = " ".join(["palabra"] * 5000)
        pages = [_page(1, f'Texto con comilla suelta " y luego {long_tail}')]
        findings = citations.check(pages, [])  # must return, not hang
        self.assertIsInstance(findings, list)


class ThirtyNineWordQuoteBoundaryTest(unittest.TestCase):
    def test_exactly_forty_words_is_flagged_thirty_nine_is_not(self):
        quote_39 = " ".join(["palabra"] * 39)
        quote_40 = " ".join(["palabra"] * 40)
        pages_39 = [_page(1, f'Dice que "{quote_39}" en el texto.')]
        pages_40 = [_page(1, f'Dice que "{quote_40}" en el texto.')]
        findings_39 = citations.check(pages_39, [])
        findings_40 = citations.check(pages_40, [])
        self.assertEqual(
            [f for f in findings_39 if f.rule_id == citations.LONG_QUOTE_NOT_BLOCK_RULE_ID],
            [],
        )
        self.assertEqual(
            len([f for f in findings_40 if f.rule_id == citations.LONG_QUOTE_NOT_BLOCK_RULE_ID]),
            1,
        )


class PrecedenceArbitrationTest(unittest.TestCase):
    """thesis-normative-governance design.md D7, spec: Precedence Conflict
    Arbitration. `_apply_precedence` is a pure function over a list,
    triangulated directly with constructed `RuleFinding` fixtures -- no
    fake module, no synthetic production rule (design.md D7's "honest TDD
    strategy for an untestable-in-production path")."""

    @staticmethod
    def _finding(**overrides):
        defaults = dict(
            finding_type="structure",
            severity="high",
            confidence=0.9,
            title="t",
            explanation="e",
            recommendation="r",
            evidence_text="ev",
            page_number=5,
            section_index=None,
            rule_id="fake.rule",
            metadata={},
        )
        defaults.update(overrides)
        return RuleFinding(**defaults)

    def test_lower_tier_finding_sharing_a_conflict_key_is_demoted(self):
        import app.rules as rules_module

        tier1 = self._finding(
            rule_id="reglamento_structure.articulo_8_altered",
            normative_source_type="reglamento_tesis",
            metadata={"conflict_key": "art8-text", "precedence_tier": 1},
        )
        tier3 = self._finding(
            rule_id="gt_structure.missing_required_section",
            severity="high",
            normative_source_type="gt_guide",
            metadata={"conflict_key": "art8-text", "precedence_tier": 3},
        )
        resolved = rules_module._apply_precedence([tier3, tier1])

        winner = next(f for f in resolved if f.rule_id == tier1.rule_id)
        loser = next(f for f in resolved if f.rule_id == tier3.rule_id)

        self.assertEqual(winner.severity, "high")
        self.assertNotIn("superseded_by_higher_precedence", winner.metadata)

        self.assertEqual(loser.severity, "low")
        self.assertEqual(
            loser.metadata["superseded_by_higher_precedence"],
            {
                "winning_source_type": "reglamento_tesis",
                "winning_tier": 1,
                "winning_rule_id": "reglamento_structure.articulo_8_altered",
            },
        )
        # demoted, never dropped -- both findings survive
        self.assertEqual(len(resolved), 2)

    def test_findings_without_a_shared_conflict_key_are_unaffected(self):
        import app.rules as rules_module

        a = self._finding(rule_id="a.rule", metadata={"precedence_tier": 1})
        b = self._finding(rule_id="b.rule", metadata={"precedence_tier": 3})
        resolved = rules_module._apply_precedence([a, b])
        self.assertEqual(resolved, [a, b])

    def test_three_way_same_tier_tie_resolves_by_first_emitted_order(self):
        import app.rules as rules_module

        first = self._finding(rule_id="first.rule", metadata={"conflict_key": "k", "precedence_tier": 2})
        second = self._finding(rule_id="second.rule", metadata={"conflict_key": "k", "precedence_tier": 2})
        third = self._finding(rule_id="third.rule", metadata={"conflict_key": "k", "precedence_tier": 2})
        resolved = rules_module._apply_precedence([first, second, third])

        winner = next(f for f in resolved if f.rule_id == "first.rule")
        self.assertNotIn("superseded_by_higher_precedence", winner.metadata)
        for loser_rule_id in ("second.rule", "third.rule"):
            loser = next(f for f in resolved if f.rule_id == loser_rule_id)
            self.assertEqual(
                loser.metadata["superseded_by_higher_precedence"]["winning_rule_id"],
                "first.rule",
            )

    def test_run_rules_wires_apply_precedence_as_its_final_step(self):
        # A finding constructed with a conflict_key would never survive
        # run_rules() untouched if _apply_precedence were not wired in --
        # proven here via a fixture module returning two conflicting
        # findings directly (no real production module emits conflict_key
        # today; see ConflictKeyLimitationGuardTest below).
        import app.rules as rules_module

        class FakeConflictingModule:
            NORMATIVE_SOURCE_TYPE = "reglamento_tesis"

            @staticmethod
            def check(pages, sections):
                return [
                    RuleFinding(
                        finding_type="structure",
                        severity="high",
                        confidence=0.95,
                        title="tier1",
                        explanation="e",
                        recommendation="r",
                        evidence_text="ev1",
                        page_number=1,
                        section_index=None,
                        rule_id="fake.tier1",
                        metadata={"conflict_key": "shared-key"},
                    ),
                ]

        class FakeLosingModule:
            NORMATIVE_SOURCE_TYPE = "gt_guide"

            @staticmethod
            def check(pages, sections):
                return [
                    RuleFinding(
                        finding_type="writing_style",
                        severity="high",
                        confidence=0.95,
                        title="tier3",
                        explanation="e",
                        recommendation="r",
                        evidence_text="ev3",
                        page_number=1,
                        section_index=None,
                        rule_id="fake.tier3",
                        metadata={"conflict_key": "shared-key"},
                    ),
                ]

        original_modules = rules_module._RULE_MODULES
        rules_module._RULE_MODULES = (FakeConflictingModule(), FakeLosingModule())
        try:
            findings = run_rules([_page(1, "text")], [])
        finally:
            rules_module._RULE_MODULES = original_modules

        loser = next(f for f in findings if f.rule_id == "fake.tier3")
        self.assertEqual(loser.severity, "low")
        self.assertIn("superseded_by_higher_precedence", loser.metadata)


class ConflictKeyLimitationGuardTest(unittest.TestCase):
    """thesis-normative-governance design.md D7's documented, deliberate
    limitation: zero currently-registered rule module emits a
    `conflict_key`. This test fails loudly the day a real one is
    introduced without deliberate review of the arbitration behavior --
    it must NEVER be satisfied by fabricating a synthetic production rule."""

    def test_no_currently_registered_module_emits_a_conflict_key(self):
        pages = [
            _page(
                1,
                "Es decir que el resultadoo del sistema, o sea, funciona "
                "correctamente segun el analisis.",
            ),
            _page(
                2,
                " ".join(["palabra"] * 45) + ". "
                'El autor señala que "' + " ".join(["palabra"] * 55) + '" en su análisis.',
            ),
            _page(
                5,
                "REGLAMENTO DE TESIS\n\nArtículo 8°: RESPONSABILIDAD\n\n"
                "Texto alterado que no coincide con el original exigido.",
            ),
            _page(
                10,
                "Referencias\nGarcía, A., & Pérez, B. (2020). Estudio con dos "
                "autores. Editorial Z.",
            ),
        ]
        sections = [
            {
                "index": 0,
                "title": "Introducción",
                "normalized_title": "introduccion",
                "section_type": "chapter",
            },
            {
                "index": 1,
                "section_type": "references",
                "start_page_number": 10,
                "end_page_number": 10,
            },
        ]
        findings = run_rules(pages, sections)
        self.assertGreater(
            len(findings), 3, "fixture should exercise multiple rule modules"
        )
        offending = [f.rule_id for f in findings if "conflict_key" in f.metadata]
        self.assertEqual(
            offending,
            [],
            "a registered module now emits conflict_key -- this is a deliberate "
            "design change (design.md D7), review before enabling arbitration "
            "coverage for it: " + str(offending),
        )


class NonGoalsStructuralGuardTest(unittest.TestCase):
    """thesis-normative-governance design.md D8, spec: Physical-Layout
    Non-Goal. Enforced structurally: no registered module's `*_RULE_ID`
    constant may claim layout coverage the extraction pipeline cannot
    support."""

    _LAYOUT_TOKEN_PATTERN = re.compile(
        r"margen|interlineado|fuente|sangria|cursiva|paginacion"
    )

    def test_scanner_correctly_fails_against_a_deliberately_violating_rule_id(self):
        # Proves the scanner is not a no-op before trusting its clean pass.
        violating = "reglamento_structure.margen_incorrecto"
        self.assertIsNotNone(self._LAYOUT_TOKEN_PATTERN.search(fold(violating)))
        # Accent-bearing variant also caught, mid-string.
        self.assertIsNotNone(
            self._LAYOUT_TOKEN_PATTERN.search(fold("some.rule_id_with_márgen_inside"))
        )

    def test_no_registered_module_declares_a_layout_related_rule_id(self):
        import app.rules as rules_module

        offending: list[str] = []
        for module in rules_module._RULE_MODULES:
            for name in dir(module):
                if "RULE_ID" not in name:
                    continue
                value = getattr(module, name)
                if not isinstance(value, str):
                    continue
                if self._LAYOUT_TOKEN_PATTERN.search(fold(value)):
                    offending.append(f"{module.__name__}.{name}={value}")
        self.assertEqual(
            offending,
            [],
            f"layout-related rule_id constants found (design.md D8): {offending}",
        )


if __name__ == "__main__":
    unittest.main()
