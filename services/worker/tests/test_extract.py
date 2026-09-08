import importlib
import io
import os
import subprocess
import unittest
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

import app.extraction as extraction
from app.extraction import (
    DOCX_CONTENT_TYPES,
    RESOLVED_DOCX_CONTENT_TYPE,
    ExtractedPage,
    detect_sections,
    extract_text,
)
from fixtures import build_minimal_docx, build_minimal_pdf

DocxConversionError = getattr(extraction, "DocxConversionError")
_convert_docx_to_pdf = getattr(extraction, "_convert_docx_to_pdf")


def _page(page_number, text):
    return ExtractedPage(page_number=page_number, section_title=None, text=text)


class SectionDetectionTest(unittest.TestCase):
    """Pure unit tests for `detect_sections` — no PDF bytes needed, since
    detection runs over already-extracted per-page text (design.md D2)."""

    def test_no_heading_pattern_yields_zero_sections_no_crash(self):
        sections = detect_sections([_page(1, "Just some ordinary paragraph text.")])
        self.assertEqual(sections, [])

    def test_chapter_heading_is_detected_with_high_confidence(self):
        sections = detect_sections([_page(3, "CAPÍTULO 3\nBody text follows.")])
        self.assertEqual(len(sections), 1)
        section = sections[0]
        self.assertEqual(section.title, "CAPÍTULO 3")
        self.assertEqual(section.section_type, "chapter")
        self.assertEqual(section.start_page_number, 3)
        self.assertFalse(section.is_location_uncertain)
        self.assertEqual(section.metadata["pattern"], "chapter")
        self.assertAlmostEqual(section.metadata["confidence"], 0.95)

    def test_chapter_heading_matches_the_corpus_grave_accent_spelling(self):
        # data/academic-rules/tesis_guia_trabajo_gt.txt:598 genuinely spells
        # this with a grave accent (CAPÌTULO, not CAPÍTULO) — accent-folding
        # must normalize both to the same match.
        sections = detect_sections([_page(1, "CAPÌTULO 1")])
        self.assertEqual(len(sections), 1)
        self.assertEqual(sections[0].section_type, "chapter")

    def test_gt_keyword_headings_map_to_the_right_section_type(self):
        sections = detect_sections(
            [
                _page(1, "INTRODUCCIÓN"),
                _page(10, "MARCO TEÓRICO"),
                _page(50, "BIBLIOGRAFIA"),
                _page(60, "ANEXOS"),
            ]
        )
        by_page = {s.start_page_number: s for s in sections}
        self.assertEqual(by_page[1].section_type, "chapter")
        self.assertEqual(by_page[10].section_type, "chapter")
        self.assertEqual(by_page[50].section_type, "references")
        self.assertEqual(by_page[60].section_type, "appendix")
        for section in sections:
            self.assertEqual(section.metadata["pattern"], "gt_keyword")
            self.assertFalse(section.is_location_uncertain)

    def test_numbered_headings_assign_section_vs_subsection_by_depth(self):
        sections = detect_sections(
            [
                _page(1, "CAPÍTULO 1"),
                _page(2, "1.1 Subsection heading"),
                _page(3, "1.1.1 Sub-subsection heading"),
            ]
        )
        self.assertEqual(len(sections), 3)
        chapter, section, subsection = sections
        self.assertEqual(chapter.section_type, "chapter")
        self.assertIsNone(chapter.parent_index)
        self.assertEqual(section.section_type, "subsection")
        self.assertEqual(section.parent_index, chapter.index)
        self.assertEqual(subsection.section_type, "subsection")
        self.assertEqual(subsection.parent_index, section.index)

    def test_all_caps_heading_is_flagged_uncertain_not_dropped(self):
        sections = detect_sections([_page(5, "RESULTADOS Y DISCUSIÓN")])
        self.assertEqual(len(sections), 1)
        section = sections[0]
        self.assertEqual(section.section_type, "unknown")
        self.assertTrue(section.is_location_uncertain)
        self.assertAlmostEqual(section.metadata["confidence"], 0.55)

    def test_all_caps_line_inside_references_block_is_excluded_not_misdetected(self):
        sections = detect_sections(
            [
                _page(40, "BIBLIOGRAFIA"),
                _page(41, "SMITH, J. AND DOE, A."),
                _page(42, "CAPÍTULO 5"),
            ]
        )
        # Only the references heading and the following real chapter heading
        # are detected — the ALL-CAPS reference-list entry in between is not.
        titles = [s.title for s in sections]
        self.assertEqual(titles, ["BIBLIOGRAFIA", "CAPÍTULO 5"])

    def test_toc_dotted_leader_line_is_excluded_entirely(self):
        sections = detect_sections(
            [_page(2, "CAPÍTULO 1 ..................... 5\nReal body text.")]
        )
        self.assertEqual(sections, [])

    def test_zero_headings_across_a_whole_document_is_not_a_crash(self):
        pages = [_page(i, f"Ordinary paragraph on page {i}.") for i in range(1, 6)]
        sections = detect_sections(pages)
        self.assertEqual(sections, [])

    def test_offsets_are_real_character_positions_into_full_text(self):
        pages = [_page(1, "Intro paragraph."), _page(2, "CAPÍTULO 2\nMore text.")]
        sections = detect_sections(pages)
        self.assertEqual(len(sections), 1)
        section = sections[0]
        full_text = "\n\n".join(p.text for p in pages)
        self.assertEqual(
            full_text[section.start_offset : section.end_offset], "CAPÍTULO 2"
        )


class DocxConversionTest(unittest.TestCase):
    def setUp(self):
        self._previous_binary = os.environ.pop("SOFFICE_BINARY", None)

    def tearDown(self):
        if self._previous_binary is not None:
            os.environ["SOFFICE_BINARY"] = self._previous_binary
        else:
            os.environ.pop("SOFFICE_BINARY", None)

    def test_docx_upload_uses_safe_libreoffice_args_and_cleans_tempdir(self):
        docx_bytes = build_minimal_docx(["The hostile filename must not reach argv."])
        converted_pdf = build_minimal_pdf("CAPÍTULO 1")
        captured = {}

        def fake_run(args, **kwargs):
            outdir = Path(args[args.index("--outdir") + 1])
            captured["args"] = args
            captured["kwargs"] = kwargs
            captured["outdir"] = outdir
            captured["input_path"] = Path(args[-1])
            self.assertEqual(captured["input_path"].name, "input.docx")
            self.assertEqual(captured["input_path"].read_bytes(), docx_bytes)
            (outdir / "input.pdf").write_bytes(converted_pdf)
            return subprocess.CompletedProcess(args=args, returncode=0, stdout=b"", stderr=b"")

        with patch("app.extraction.shutil.which", return_value="/usr/bin/soffice"), patch(
            "app.extraction.subprocess.run", side_effect=fake_run
        ):
            result = extract_text(
                filename='"; rm -rf /.docx',
                content_type=next(iter(DOCX_CONTENT_TYPES)),
                data=docx_bytes,
            )

        self.assertEqual(result.content_type, RESOLVED_DOCX_CONTENT_TYPE)
        self.assertEqual(result.pages[0].page_number, 1)
        self.assertEqual(result.pages[0].section_title, "CAPÍTULO 1")
        self.assertEqual(result.sections[0].title, "CAPÍTULO 1")
        self.assertFalse(captured["outdir"].exists())
        self.assertIsInstance(captured["args"], list)
        self.assertEqual(captured["args"][0], "/usr/bin/soffice")
        self.assertIn("--headless", captured["args"])
        self.assertIn("--norestore", captured["args"])
        self.assertIn("--convert-to", captured["args"])
        self.assertIn("pdf", captured["args"])
        self.assertTrue(
            any(str(arg).startswith("-env:UserInstallation=file://") for arg in captured["args"])
        )
        self.assertNotEqual(captured["kwargs"].get("shell"), True)
        self.assertEqual(captured["kwargs"]["capture_output"], True)
        self.assertEqual(captured["kwargs"]["check"], False)
        self.assertGreater(captured["kwargs"]["timeout"], 0)
        self.assertNotIn('"; rm -rf /', " ".join(str(arg) for arg in captured["args"]))

    def test_docx_and_native_pdf_share_downstream_per_page_extraction(self):
        pdf_bytes = build_minimal_pdf("CAPÍTULO 1")
        docx_bytes = build_minimal_docx(["DOCX bytes are converted before extraction."])

        with patch("app.extraction._convert_docx_to_pdf", return_value=pdf_bytes) as convert:
            docx_result = extract_text(
                filename="thesis.docx",
                content_type=next(iter(DOCX_CONTENT_TYPES)),
                data=docx_bytes,
            )
        pdf_result = extract_text(
            filename="thesis.pdf",
            content_type="application/pdf",
            data=pdf_bytes,
        )

        convert.assert_called_once_with(docx_bytes)
        self.assertEqual(docx_result.content_type, RESOLVED_DOCX_CONTENT_TYPE)
        self.assertEqual(
            [(p.page_number, p.section_title, p.text) for p in docx_result.pages],
            [(p.page_number, p.section_title, p.text) for p in pdf_result.pages],
        )
        self.assertEqual(
            [(s.title, s.section_type, s.start_page_number) for s in docx_result.sections],
            [(s.title, s.section_type, s.start_page_number) for s in pdf_result.sections],
        )

    def test_missing_libreoffice_binary_fails_loudly(self):
        with patch("app.extraction.shutil.which", return_value=None):
            with self.assertRaisesRegex(DocxConversionError, "LibreOffice.*SOFFICE_BINARY"):
                _convert_docx_to_pdf(b"docx bytes")

    def test_libreoffice_non_zero_exit_fails_loudly_and_cleans_tempdir(self):
        captured = {}

        def fake_run(args, **kwargs):
            captured["outdir"] = Path(args[args.index("--outdir") + 1])
            return subprocess.CompletedProcess(
                args=args,
                returncode=3,
                stdout=b"",
                stderr=b"conversion failed",
            )

        with patch("app.extraction.shutil.which", return_value="/usr/bin/soffice"), patch(
            "app.extraction.subprocess.run", side_effect=fake_run
        ):
            with self.assertRaisesRegex(DocxConversionError, "exit 3.*conversion failed"):
                _convert_docx_to_pdf(b"docx bytes")

        self.assertFalse(captured["outdir"].exists())

    def test_libreoffice_timeout_fails_loudly_and_cleans_tempdir(self):
        captured = {}

        def fake_run(args, **kwargs):
            captured["outdir"] = Path(args[args.index("--outdir") + 1])
            raise subprocess.TimeoutExpired(cmd=args, timeout=kwargs["timeout"])

        with patch("app.extraction.shutil.which", return_value="/usr/bin/soffice"), patch(
            "app.extraction.subprocess.run", side_effect=fake_run
        ):
            with self.assertRaisesRegex(DocxConversionError, "timed out"):
                _convert_docx_to_pdf(b"docx bytes")

        self.assertFalse(captured["outdir"].exists())


class ExtractEndpointTest(unittest.TestCase):
    def setUp(self):
        main = importlib.import_module("app.main")
        self.client = TestClient(main.create_app())

    def test_extracts_text_and_page_provenance_from_a_real_pdf(self):
        pdf_bytes = build_minimal_pdf("Hello Thesis Text")

        response = self.client.post(
            "/internal/extract",
            files={"file": ("thesis.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["content_type"], "application/pdf")
        self.assertEqual(body["page_count"], 1)
        self.assertEqual(len(body["pages"]), 1)
        self.assertEqual(body["pages"][0]["page_number"], 1)
        self.assertIn("Hello Thesis Text", body["pages"][0]["text"])
        self.assertIn("Hello Thesis Text", body["full_text"])
        # No heading pattern in "Hello Thesis Text" -> section_title stays
        # null, and the response still carries an (empty) sections list.
        self.assertIsNone(body["pages"][0]["section_title"])
        self.assertEqual(body["sections"], [])

    def test_extracts_sections_and_per_page_section_title_from_a_real_pdf(self):
        pdf_bytes = build_minimal_pdf("CAPÍTULO 1")

        response = self.client.post(
            "/internal/extract",
            files={"file": ("thesis.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body["sections"]), 1)
        section = body["sections"][0]
        self.assertEqual(section["title"], "CAPÍTULO 1")
        self.assertEqual(section["section_type"], "chapter")
        self.assertEqual(section["start_page_number"], 1)
        self.assertIsNone(section["parent_index"])
        self.assertEqual(body["pages"][0]["section_title"], "CAPÍTULO 1")

    def test_extracts_docx_via_converted_pdf(self):
        docx_bytes = build_minimal_docx(["Original DOCX bytes."])
        converted_pdf = build_minimal_pdf("Converted PDF page text")

        with patch("app.extraction._convert_docx_to_pdf", return_value=converted_pdf):
            response = self.client.post(
                "/internal/extract",
                files={
                    "file": (
                        "thesis.docx",
                        io.BytesIO(docx_bytes),
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    )
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(
            body["content_type"],
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        self.assertEqual(body["page_count"], 1)
        self.assertEqual(body["pages"][0]["page_number"], 1)
        self.assertIn("Converted PDF page text", body["full_text"])

    def test_rejects_unsupported_content_type(self):
        response = self.client.post(
            "/internal/extract",
            files={"file": ("notes.txt", io.BytesIO(b"plain text"), "text/plain")},
        )

        self.assertEqual(response.status_code, 415)

    def test_rejects_empty_file(self):
        response = self.client.post(
            "/internal/extract",
            files={"file": ("thesis.pdf", io.BytesIO(b""), "application/pdf")},
        )

        self.assertEqual(response.status_code, 422)

    def test_rejects_corrupt_pdf(self):
        response = self.client.post(
            "/internal/extract",
            files={
                "file": (
                    "thesis.pdf",
                    io.BytesIO(b"%PDF-1.4 this is not a real pdf body"),
                    "application/pdf",
                )
            },
        )

        self.assertEqual(response.status_code, 422)

    def test_rejects_docx_when_conversion_fails(self):
        with patch(
            "app.extraction._convert_docx_to_pdf",
            side_effect=DocxConversionError("LibreOffice conversion failed"),
        ):
            response = self.client.post(
                "/internal/extract",
                files={
                    "file": (
                        "thesis.docx",
                        io.BytesIO(b"not a real zip/docx package"),
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    )
                },
            )

        self.assertEqual(response.status_code, 422)


class MarkItDownLlmTextTest(unittest.TestCase):
    def setUp(self):
        self._previous_flag = os.environ.pop("PG1_ENABLE_MARKITDOWN_LLM_TEXT", None)

    def tearDown(self):
        if self._previous_flag is not None:
            os.environ["PG1_ENABLE_MARKITDOWN_LLM_TEXT"] = self._previous_flag
        else:
            os.environ.pop("PG1_ENABLE_MARKITDOWN_LLM_TEXT", None)

    def test_feature_flag_off_preserves_response_shape_without_llm_text(self):
        docx_bytes = build_minimal_docx(["Legacy extractor text."])

        def _factory_must_not_be_called():
            raise AssertionError("MarkItDown converter must not be constructed")

        with patch(
            "app.extraction._convert_docx_to_pdf",
            return_value=build_minimal_pdf("Legacy extractor text."),
        ):
            result = extract_text(
                filename="thesis.docx",
                content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                data=docx_bytes,
                markitdown_converter_factory=_factory_must_not_be_called,
            )

        body = result.to_dict()
        self.assertIn("Legacy extractor text.", body["full_text"])
        self.assertNotIn("llm_text", body)

    def test_feature_flag_on_adds_llm_text_without_changing_pages_or_sections(self):
        os.environ["PG1_ENABLE_MARKITDOWN_LLM_TEXT"] = "1"
        docx_bytes = build_minimal_docx(["Legacy page text."])

        class FakeConverter:
            def convert(self, source: str) -> object:
                self.source = source
                return SimpleNamespace(text_content="# Markdown LLM text")

        with patch(
            "app.extraction._convert_docx_to_pdf",
            return_value=build_minimal_pdf("Legacy page text."),
        ):
            result = extract_text(
                filename="thesis.docx",
                content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                data=docx_bytes,
                markitdown_converter_factory=FakeConverter,
            )

        body = result.to_dict()
        self.assertEqual(body["llm_text"], "# Markdown LLM text")
        self.assertIn("Legacy page text.", body["full_text"])
        self.assertEqual(len(body["pages"]), 1)
        self.assertIn("Legacy page text.", body["pages"][0]["text"])
        self.assertEqual(body["sections"], [])

    def test_feature_flag_on_markitdown_unavailable_falls_back_without_llm_text(self):
        os.environ["PG1_ENABLE_MARKITDOWN_LLM_TEXT"] = "1"
        docx_bytes = build_minimal_docx(["Legacy fallback text."])

        def _unavailable_factory():
            raise ImportError("markitdown is not installed")

        with patch(
            "app.extraction._convert_docx_to_pdf",
            return_value=build_minimal_pdf("Legacy fallback text."),
        ):
            result = extract_text(
                filename="thesis.docx",
                content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                data=docx_bytes,
                markitdown_converter_factory=_unavailable_factory,
            )

        body = result.to_dict()
        self.assertIn("Legacy fallback text.", body["full_text"])
        self.assertNotIn("llm_text", body)

    def test_feature_flag_on_markitdown_timeout_falls_back_without_llm_text(self):
        os.environ["PG1_ENABLE_MARKITDOWN_LLM_TEXT"] = "1"
        docx_bytes = build_minimal_docx(["Legacy timeout text."])

        class SlowConverter:
            def convert(self, source: str) -> object:
                Event().wait(0.2)
                return SimpleNamespace(text_content="too late")

        with patch(
            "app.extraction._convert_docx_to_pdf",
            return_value=build_minimal_pdf("Legacy timeout text."),
        ):
            result = extract_text(
                filename="thesis.docx",
                content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                data=docx_bytes,
                markitdown_converter_factory=SlowConverter,
                markitdown_timeout_seconds=0.01,
            )

        body = result.to_dict()
        self.assertIn("Legacy timeout text.", body["full_text"])
        self.assertNotIn("llm_text", body)


if __name__ == "__main__":
    unittest.main()
