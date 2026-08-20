"""Tests for `app/rules/reglamento_structure.py` (thesis-normative-governance,
PR2 "grounded rules", design.md D5, spec: Reglamento Structure Rules).

Every text fixture below is a literal excerpt (or a minimally-altered
variant, for the negative cases) of
`data/academic-rules/lineamientos_ingenieria_sistemas.txt` — the real
Reglamento de Tesis corpus this module is grounded in. No fabricated
grounding text is used anywhere in this file.
"""
from __future__ import annotations

import difflib
import unittest

from app.rules import reglamento_structure
from app.rules.base import squeeze


def _page(page_number, text):
    return {"page_number": page_number, "section_title": None, "text": text}


# Literal corpus excerpts (data/academic-rules/lineamientos_ingenieria_sistemas.txt).
_CARATULA_EXTERIOR_TEXT = (
    "UNIVERSIDAD MARIANO GÁLVEZ DE GUATEMALA\nFACULTAD DE INGENIERÍA EN "
    "SISTEMAS DE INFORMACIÓN"
)
_CARATULA_INTERIOR_TEXT = (
    "TRABAJO DE GRADUACIÓN PRESENTADO POR:\nNOMBRE DEL GRADUANDO (A)\n"
    "PREVIO A OPTAR AL GRADO ACADÉMICO DE\nLICENCIADO EN INGENIERÍA EN "
    "SISTEMAS DE INFORMACIÓN"
)
_AUTORIDADES_TEXT = (
    "AUTORIDADES DE LA FACULTAD Y ASESOR DEL TRABAJO\nDE GRADUACIÓN.\n"
    "DECANO DE LA FACULTAD: ING. JORGE ALBERTO ARIAS TOBAR"
)
_ORDEN_IMPRESION_TEXT = "AGREGAR LA ORDEN DE IMPRESIÓN ESCANEADA Y\nENUMERAR"
_ARTICULO_8_PAGE_TEXT = (
    "REGLAMENTO DE TESIS\n\nArtículo 8°: RESPONSABILIDAD\n\n"
    "Solamente el autor es responsable de los conceptos expresados en el\n"
    "trabajo de tesis. Su aprobación en manera alguna implica\n"
    "responsabilidad para la Universidad."
)
_INDICE_TEXT = "INDICE"


class PreliminarySequenceTest(unittest.TestCase):
    def test_correct_sequence_produces_no_finding(self):
        pages = [
            _page(1, _CARATULA_EXTERIOR_TEXT),
            _page(2, _CARATULA_INTERIOR_TEXT),
            _page(3, _AUTORIDADES_TEXT),
            _page(4, _ORDEN_IMPRESION_TEXT),
            _page(5, _ARTICULO_8_PAGE_TEXT),
            _page(6, _INDICE_TEXT),
        ]
        findings = reglamento_structure.check(pages)
        sequence_findings = [
            f
            for f in findings
            if f.rule_id
            in (
                reglamento_structure.MISSING_PRELIMINARY_PAGE_RULE_ID,
                reglamento_structure.PRELIMINARY_PAGE_OUT_OF_ORDER_RULE_ID,
            )
        ]
        self.assertEqual(sequence_findings, [])

    def test_missing_preliminary_page_is_flagged_with_detected_pages_as_evidence(self):
        pages = [
            _page(1, _CARATULA_EXTERIOR_TEXT),
            _page(2, _CARATULA_INTERIOR_TEXT),
            # page 3 (autoridades y tribunal) omitted entirely
            _page(4, _ORDEN_IMPRESION_TEXT),
            _page(5, _ARTICULO_8_PAGE_TEXT),
            _page(6, _INDICE_TEXT),
        ]
        findings = reglamento_structure.check(pages)
        missing = [
            f
            for f in findings
            if f.rule_id == reglamento_structure.MISSING_PRELIMINARY_PAGE_RULE_ID
        ]
        self.assertEqual(len(missing), 1)
        self.assertIn("autoridades y tribunal", missing[0].metadata["missing_element"])
        self.assertIn("carátula exterior", missing[0].evidence_text)
        self.assertEqual(missing[0].normative_source_type, None)  # stamped only by run_rules()

    def test_out_of_order_sequence_is_flagged(self):
        pages = [
            _page(1, _CARATULA_EXTERIOR_TEXT),
            _page(2, _INDICE_TEXT),  # índice (last element) appears too early
            _page(3, _CARATULA_INTERIOR_TEXT),
            _page(4, _AUTORIDADES_TEXT),
            _page(5, _ORDEN_IMPRESION_TEXT),
            _page(6, _ARTICULO_8_PAGE_TEXT),
        ]
        findings = reglamento_structure.check(pages)
        out_of_order = [
            f
            for f in findings
            if f.rule_id == reglamento_structure.PRELIMINARY_PAGE_OUT_OF_ORDER_RULE_ID
        ]
        self.assertEqual(len(out_of_order), 1)
        self.assertIn("índice", out_of_order[0].evidence_text)

    def test_intra_word_split_marker_text_still_matches(self):
        # corpus-style spurious intra-word space (see corpus L220/276/310:
        # "numeraci ón", "m ismas", "marg en") applied to a marker phrase.
        split_text = "UNIVERSIDAD MARIANO GÁLVEZ DE GUATEMA LA"
        pages = [
            _page(1, split_text),
            _page(2, _CARATULA_INTERIOR_TEXT),
            _page(3, _AUTORIDADES_TEXT),
            _page(4, _ORDEN_IMPRESION_TEXT),
            _page(5, _ARTICULO_8_PAGE_TEXT),
            _page(6, _INDICE_TEXT),
        ]
        findings = reglamento_structure.check(pages)
        missing = [
            f
            for f in findings
            if f.rule_id == reglamento_structure.MISSING_PRELIMINARY_PAGE_RULE_ID
            and "exterior" in f.metadata["missing_element"]
        ]
        self.assertEqual(missing, [])


class ArticuloOchoTest(unittest.TestCase):
    def test_verbatim_text_present_produces_no_finding(self):
        pages = [_page(5, _ARTICULO_8_PAGE_TEXT)]
        findings = reglamento_structure.check(pages)
        articulo_findings = [
            f
            for f in findings
            if f.rule_id
            in (
                reglamento_structure.ARTICULO_8_MISSING_RULE_ID,
                reglamento_structure.ARTICULO_8_ALTERED_RULE_ID,
            )
        ]
        self.assertEqual(articulo_findings, [])

    def test_altered_text_is_flagged_with_the_literal_altered_text_as_evidence(self):
        # A single-word alteration ("Universidad" -> "Facultad") of the
        # otherwise-verbatim paragraph. No surrounding heading noise here,
        # matching a page whose extracted text is that paragraph itself
        # (see the ratio-boundary test below for the diluted, headed case).
        altered_page_text = (
            "Solamente el autor es responsable de los conceptos expresados en el\n"
            "trabajo de tesis. Su aprobación en manera alguna implica\n"
            "responsabilidad para la Facultad."
        )
        pages = [_page(5, altered_page_text)]
        findings = reglamento_structure.check(pages)
        altered = [
            f
            for f in findings
            if f.rule_id == reglamento_structure.ARTICULO_8_ALTERED_RULE_ID
        ]
        self.assertEqual(len(altered), 1)
        self.assertIn("responsabilidad para la Facultad", altered[0].evidence_text)
        self.assertEqual(altered[0].page_number, 5)

    def test_missing_text_across_every_page_is_flagged(self):
        pages = [
            _page(1, "Contenido de portada sin relación con el artículo 8."),
            _page(2, "Otra página sin ninguna relación temática."),
        ]
        findings = reglamento_structure.check(pages)
        missing = [
            f
            for f in findings
            if f.rule_id == reglamento_structure.ARTICULO_8_MISSING_RULE_ID
        ]
        self.assertEqual(len(missing), 1)

    def test_ratio_boundary_classifies_altered_at_threshold_and_missing_below_it(self):
        # Explicit boundary exercise (design.md D5): progressively truncate
        # the required text from the end, using the SAME ratio computation
        # reglamento_structure.py uses, until the ratio crosses
        # ARTICULO_8_MATCH_RATIO. This proves the >= 0.85 vs < 0.85 split
        # without hardcoding a fragile pre-computed magic string.
        required_squeezed = squeeze(reglamento_structure.REQUIRED_ARTICLE_8_TEXT)
        full_text = reglamento_structure.REQUIRED_ARTICLE_8_TEXT
        at_or_above, below = None, None
        for cut in range(1, len(full_text)):
            candidate = full_text[: len(full_text) - cut]
            ratio = difflib.SequenceMatcher(
                None, required_squeezed, squeeze(candidate)
            ).ratio()
            if ratio >= reglamento_structure.ARTICULO_8_MATCH_RATIO:
                at_or_above = candidate
            else:
                below = candidate
                break
        self.assertIsNotNone(at_or_above, "could not find a near-threshold candidate")
        self.assertIsNotNone(below, "could not find a below-threshold candidate")

        altered_findings = reglamento_structure.check([_page(5, at_or_above)])
        missing_findings = reglamento_structure.check([_page(5, below)])
        self.assertTrue(
            any(
                f.rule_id == reglamento_structure.ARTICULO_8_ALTERED_RULE_ID
                for f in altered_findings
            )
        )
        self.assertTrue(
            any(
                f.rule_id == reglamento_structure.ARTICULO_8_MISSING_RULE_ID
                for f in missing_findings
            )
        )


class ZeroEvidenceSkipTest(unittest.TestCase):
    def test_empty_pages_returns_no_findings(self):
        self.assertEqual(reglamento_structure.check([]), [])

    def test_fewer_than_scan_window_pages_with_no_text_returns_no_findings(self):
        pages = [_page(1, ""), _page(2, None)]
        self.assertEqual(reglamento_structure.check(pages), [])

    def test_sections_argument_is_accepted_but_unused(self):
        # design.md D5: deliberately not consulted (preliminary pages carry
        # no reliable heading shape) — must not raise or change behavior.
        pages = [_page(5, _ARTICULO_8_PAGE_TEXT)]
        with_sections = reglamento_structure.check(
            pages, sections=[{"section_type": "chapter"}]
        )
        without_sections = reglamento_structure.check(pages, sections=None)
        self.assertEqual(with_sections, without_sections)


class NonGoalsConstantTest(unittest.TestCase):
    def test_not_covered_constant_is_a_non_empty_tuple_of_strings(self):
        self.assertIsInstance(reglamento_structure.NOT_COVERED, tuple)
        self.assertTrue(reglamento_structure.NOT_COVERED)
        self.assertTrue(all(isinstance(item, str) for item in reglamento_structure.NOT_COVERED))


class NormativeSourceTypeTest(unittest.TestCase):
    def test_module_declares_reglamento_tesis_as_its_normative_source_type(self):
        self.assertEqual(reglamento_structure.NORMATIVE_SOURCE_TYPE, "reglamento_tesis")


if __name__ == "__main__":
    unittest.main()
