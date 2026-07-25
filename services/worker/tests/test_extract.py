import importlib
import io
import unittest

from fastapi.testclient import TestClient

from fixtures import build_minimal_docx, build_minimal_pdf


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

    def test_extracts_text_from_a_real_docx(self):
        docx_bytes = build_minimal_docx(["First paragraph.", "Second paragraph."])

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
        self.assertGreaterEqual(body["page_count"], 1)
        self.assertIn("First paragraph.", body["full_text"])
        self.assertIn("Second paragraph.", body["full_text"])

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

    def test_rejects_corrupt_docx(self):
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


if __name__ == "__main__":
    unittest.main()
