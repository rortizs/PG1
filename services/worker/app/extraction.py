"""PDF/DOCX text extraction.

Deliberately minimal and honest: `pypdf` for PDF page text, `python-docx` for
DOCX paragraph text. No OCR, no layout analysis — if a page/paragraph has no
extractable text layer, it is reported as empty rather than guessed at.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from io import BytesIO

from docx import Document
from docx.opc.exceptions import PackageNotFoundError
from pypdf import PdfReader

PDF_CONTENT_TYPES = {"application/pdf"}
DOCX_CONTENT_TYPES = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
RESOLVED_PDF_CONTENT_TYPE = "application/pdf"
RESOLVED_DOCX_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


class ExtractionError(RuntimeError):
    """Base error for extraction failures — never silently swallowed."""


class UnsupportedContentTypeError(ExtractionError):
    """Raised when the uploaded file is neither PDF nor DOCX."""


class CorruptFileError(ExtractionError):
    """Raised when the uploaded file cannot be parsed as its declared type."""


@dataclass(frozen=True)
class ExtractedPage:
    page_number: int | None
    section_title: str | None
    text: str


@dataclass(frozen=True)
class ExtractionResult:
    filename: str
    content_type: str
    page_count: int
    pages: list[ExtractedPage]
    full_text: str

    def to_dict(self) -> dict:
        return {
            "filename": self.filename,
            "content_type": self.content_type,
            "page_count": self.page_count,
            "pages": [asdict(page) for page in self.pages],
            "full_text": self.full_text,
        }


def _extract_pdf(data: bytes) -> tuple[list[ExtractedPage], str]:
    try:
        reader = PdfReader(BytesIO(data))
        page_count = len(reader.pages)
        if page_count == 0:
            raise CorruptFileError("PDF has zero pages")
        pages = [
            ExtractedPage(
                page_number=index,
                section_title=None,
                text=(page.extract_text() or "").strip(),
            )
            for index, page in enumerate(reader.pages, start=1)
        ]
    except CorruptFileError:
        raise
    except Exception as exc:  # pypdf raises varied error types for malformed PDFs
        raise CorruptFileError(f"Unable to parse PDF: {exc}") from exc
    full_text = "\n\n".join(page.text for page in pages if page.text)
    return pages, full_text


def _extract_docx(data: bytes) -> tuple[list[ExtractedPage], str]:
    try:
        document = Document(BytesIO(data))
        paragraphs = [p.text for p in document.paragraphs if p.text.strip()]
    except PackageNotFoundError as exc:
        raise CorruptFileError(f"Unable to parse DOCX: {exc}") from exc
    except Exception as exc:
        raise CorruptFileError(f"Unable to parse DOCX: {exc}") from exc
    full_text = "\n".join(paragraphs)
    # DOCX has no fixed page concept without rendering (out of scope: no
    # layout analysis) — reported as a single provenance-free unit.
    pages = [ExtractedPage(page_number=None, section_title=None, text=full_text)]
    return pages, full_text


def extract_text(*, filename: str, content_type: str, data: bytes) -> ExtractionResult:
    if not data:
        raise ExtractionError("Uploaded file is empty")

    normalized_type = (content_type or "").split(";")[0].strip().lower()
    lowered_name = (filename or "").lower()

    if normalized_type in PDF_CONTENT_TYPES or lowered_name.endswith(".pdf"):
        pages, full_text = _extract_pdf(data)
        resolved_type = RESOLVED_PDF_CONTENT_TYPE
    elif normalized_type in DOCX_CONTENT_TYPES or lowered_name.endswith(".docx"):
        pages, full_text = _extract_docx(data)
        resolved_type = RESOLVED_DOCX_CONTENT_TYPE
    else:
        raise UnsupportedContentTypeError(
            f"Unsupported content type '{content_type}' for file '{filename}'"
        )

    return ExtractionResult(
        filename=filename or "upload",
        content_type=resolved_type,
        page_count=len(pages),
        pages=pages,
        full_text=full_text,
    )
