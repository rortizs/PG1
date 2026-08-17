"""PDF/DOCX text extraction + heading-heuristic section detection.

Deliberately minimal and honest: `pypdf` for PDF page text, `python-docx` for
DOCX paragraph text. No OCR, no layout analysis — if a page/paragraph has no
extractable text layer, it is reported as empty rather than guessed at.

Section-boundary detection (`detect_sections`) runs over already-extracted
per-page PDF text using a small ordered table of heading-heuristic regex
patterns (design.md D2). It is intentionally conservative: a genuinely
ambiguous line is still persisted with `is_location_uncertain=True` rather
than silently dropped, and a document with zero recognizable headings simply
yields zero sections (callers fall back to fixed-window chunking).
"""
from __future__ import annotations

import os
import re
import tempfile
import threading
import unicodedata
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, replace
from io import BytesIO
from pathlib import Path
from queue import Empty, Queue
from typing import Protocol

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
MARKITDOWN_LLM_TEXT_FLAG = "PG1_ENABLE_MARKITDOWN_LLM_TEXT"
MARKITDOWN_TIMEOUT_SECONDS_FLAG = "PG1_MARKITDOWN_TIMEOUT_SECONDS"
DEFAULT_MARKITDOWN_TIMEOUT_SECONDS = 10.0


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
class ExtractedSection:
    """One detected heading/section boundary.

    `index`/`parent_index` are positions into the *sibling* sections list
    returned alongside a document's pages — not database ids (those don't
    exist yet at extraction time). The Node-side `insertDocumentSections`
    resolves `parent_index` into a real `document_section.parent_section_id`
    via its own `idByIndex` map, built in the same document order these
    sections are emitted in (design.md D3's `parentIndex` contract).
    """

    index: int
    parent_index: int | None
    section_type: str
    title: str
    normalized_title: str
    start_page_number: int | None
    end_page_number: int | None
    start_offset: int
    end_offset: int
    is_location_uncertain: bool
    metadata: dict


@dataclass(frozen=True)
class ExtractionResult:
    filename: str
    content_type: str
    page_count: int
    pages: list[ExtractedPage]
    full_text: str
    sections: list[ExtractedSection] = field(default_factory=list)
    llm_text: str | None = None

    def to_dict(self) -> dict:
        payload = {
            "filename": self.filename,
            "content_type": self.content_type,
            "page_count": self.page_count,
            "pages": [asdict(page) for page in self.pages],
            "full_text": self.full_text,
            "sections": [asdict(section) for section in self.sections],
        }
        if self.llm_text is not None:
            payload["llm_text"] = self.llm_text
        return payload


# --- Section-boundary detection (design.md D2) -----------------------------

SECTION_TYPES = (
    "chapter",
    "section",
    "subsection",
    "references",
    "appendix",
    "unknown",
)

MAX_HEADING_LINE_LENGTH = 120
MAX_ALL_CAPS_WORDS = 12
UNCERTAIN_CONFIDENCE_THRESHOLD = 0.75

# GT-keyword headings default to `chapter`; these override to a more precise
# `section_type` (data/academic-rules/tesis_guia_trabajo_gt.txt:598,643,684).
_GT_KEYWORD_SECTION_TYPES = {
    "bibliografia": "references",
    "referencias": "references",
    "anexo": "appendix",
    "anexos": "appendix",
}

# Ordered pattern table (design.md D2) — shared by detection and tests so the
# regex/confidence/section_type triple never drifts between the two.
HEADING_PATTERN_TABLE = (
    {
        "name": "chapter",
        "regex": re.compile(r"^capitulo\s+([ivxlc]+|\d+)\b"),
        "confidence": 0.95,
    },
    {
        "name": "gt_keyword",
        "regex": re.compile(
            r"^(introduccion|resumen|marco teorico|marco metodologico|"
            r"conclusiones|recomendaciones|glosario|bibliografia|"
            r"referencias|anexos?)\b"
        ),
        "confidence": 0.9,
    },
    {
        "name": "numbered",
        "regex": re.compile(r"^(\d+(?:\.\d+)*)[.\s–-]+\S"),
        "confidence": 0.75,
    },
    {
        "name": "all_caps",
        "regex": re.compile(r"^[A-ZÁÉÍÓÚÑÜ0-9 ,:–-]{6,80}$"),
        "confidence": 0.55,
    },
)

_TOC_DOTTED_LEADER_PATTERN = re.compile(r"(\.{4,}|…{3,})")


def _fold(text: str) -> str:
    """Accent-fold + case-fold + collapse whitespace (the corpus itself
    contains `CAPÌTULO`/`TEORICO`/`BIBLIOGRAFIA` — folding both the input
    line and the pattern table onto the same plain-ASCII form is what makes
    the accented and non-accented spellings match identically)."""
    normalized = unicodedata.normalize("NFKD", text)
    without_accents = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return " ".join(without_accents.casefold().split())


def _join_full_text(pages: list[ExtractedPage]) -> str:
    return "\n\n".join(page.text for page in pages if page.text)


def _match_heading(line: str, folded: str, in_references_block: bool):
    """Returns (section_type, confidence, pattern_name) or None."""
    chapter_pattern = HEADING_PATTERN_TABLE[0]["regex"]
    match = chapter_pattern.match(folded)
    if match:
        return "chapter", HEADING_PATTERN_TABLE[0]["confidence"], "chapter"

    gt_pattern = HEADING_PATTERN_TABLE[1]["regex"]
    match = gt_pattern.match(folded)
    if match:
        keyword = match.group(1)
        section_type = _GT_KEYWORD_SECTION_TYPES.get(keyword, "chapter")
        return section_type, HEADING_PATTERN_TABLE[1]["confidence"], "gt_keyword"

    # The numbered and ALL-CAPS patterns are the two weakest signals — both
    # are suppressed once inside a detected references block, where numbered
    # citation lines and ALL-CAPS author surnames would otherwise produce
    # false headings (design.md D2's "not inside a detected references
    # block" guard).
    if in_references_block:
        return None

    numbered_pattern = HEADING_PATTERN_TABLE[2]["regex"]
    match = numbered_pattern.match(folded)
    if match:
        depth = match.group(1).count(".") + 1
        section_type = "section" if depth == 1 else "subsection"
        return section_type, HEADING_PATTERN_TABLE[2]["confidence"], "numbered"

    all_caps_pattern = HEADING_PATTERN_TABLE[3]["regex"]
    if all_caps_pattern.match(line):
        words = line.split()
        if len(words) <= MAX_ALL_CAPS_WORDS and not line.endswith("."):
            return "unknown", HEADING_PATTERN_TABLE[3]["confidence"], "all_caps"

    return None


def _numbered_depth(folded: str) -> int | None:
    match = HEADING_PATTERN_TABLE[2]["regex"].match(folded)
    if not match:
        return None
    return match.group(1).count(".") + 1


def detect_sections(pages: list[ExtractedPage]) -> list[ExtractedSection]:
    full_text = _join_full_text(pages)
    sections: list[ExtractedSection] = []
    levels: list[int] = []
    stack: list[tuple[int, int]] = []
    search_cursor = 0
    in_references_block = False

    for page in pages:
        if not page.text:
            continue
        for raw_line in page.text.splitlines():
            line = raw_line.strip()
            if not line or len(line) > MAX_HEADING_LINE_LENGTH:
                continue
            if _TOC_DOTTED_LEADER_PATTERN.search(line):
                continue

            folded = _fold(line)
            matched = _match_heading(line, folded, in_references_block)
            if matched is None:
                continue
            section_type, confidence, pattern_name = matched

            level = 0 if pattern_name in ("chapter", "gt_keyword", "all_caps") else (
                _numbered_depth(folded) or 1
            )

            start_offset = full_text.find(line, search_cursor)
            if start_offset == -1:
                start_offset = full_text.find(line)
            if start_offset == -1:
                # The line originates from this exact page's own text, which
                # is what full_text is built from — this should never
                # happen, but skip defensively rather than fabricate an
                # offset.
                continue
            end_offset = start_offset + len(line)
            search_cursor = end_offset

            while stack and stack[-1][0] >= level:
                stack.pop()
            parent_index = stack[-1][1] if stack else None

            index = len(sections)
            sections.append(
                ExtractedSection(
                    index=index,
                    parent_index=parent_index,
                    section_type=section_type,
                    title=line,
                    normalized_title=folded,
                    start_page_number=page.page_number,
                    end_page_number=page.page_number,
                    start_offset=start_offset,
                    end_offset=end_offset,
                    is_location_uncertain=confidence < UNCERTAIN_CONFIDENCE_THRESHOLD,
                    metadata={
                        "detector": "heading_heuristic",
                        "confidence": confidence,
                        "pattern": pattern_name,
                    },
                )
            )
            levels.append(level)
            stack.append((level, index))

            if section_type == "references":
                in_references_block = True
            elif level == 0:
                in_references_block = False

    return _assign_end_pages(sections, levels, pages)


def _assign_end_pages(
    sections: list[ExtractedSection],
    levels: list[int],
    pages: list[ExtractedPage],
) -> list[ExtractedSection]:
    last_page_number = None
    for page in reversed(pages):
        if page.page_number is not None:
            last_page_number = page.page_number
            break

    finalized: list[ExtractedSection] = []
    for i, section in enumerate(sections):
        end_page = last_page_number
        for j in range(i + 1, len(sections)):
            if levels[j] <= levels[i]:
                candidate_start = sections[j].start_page_number
                if candidate_start is not None:
                    own_start = section.start_page_number or candidate_start - 1
                    end_page = max(candidate_start - 1, own_start)
                else:
                    end_page = section.start_page_number
                break
        finalized.append(replace(section, end_page_number=end_page))
    return finalized


# --- PDF / DOCX extraction ---------------------------------------------------


def _extract_pdf(data: bytes) -> tuple[list[ExtractedPage], str, list[ExtractedSection]]:
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

    sections = detect_sections(pages)
    section_title_by_page: dict[int, str] = {}
    for section in sections:
        if section.start_page_number is not None:
            section_title_by_page.setdefault(section.start_page_number, section.title)
    pages = [
        replace(page, section_title=section_title_by_page.get(page.page_number))
        for page in pages
    ]

    full_text = _join_full_text(pages)
    return pages, full_text, sections


def _extract_docx(data: bytes) -> tuple[list[ExtractedPage], str]:
    try:
        document = Document(BytesIO(data))
        paragraphs = [p.text for p in document.paragraphs if p.text.strip()]
    except PackageNotFoundError as exc:
        raise CorruptFileError(f"Unable to parse DOCX: {exc}") from exc
    except Exception as exc:
        raise CorruptFileError(f"Unable to parse DOCX: {exc}") from exc
    full_text = "\n".join(paragraphs)
    # DOCX has no fixed page concept without rendering (out of scope for this
    # pass — real page-accurate DOCX extraction via LibreOffice conversion is
    # PR3) — reported as a single provenance-free unit, zero sections.
    pages = [ExtractedPage(page_number=None, section_title=None, text=full_text)]
    return pages, full_text


class MarkItDownConverter(Protocol):
    def convert(self, source: str) -> object: ...


MarkItDownConverterFactory = Callable[[], MarkItDownConverter]


def _is_markitdown_enabled() -> bool:
    return os.environ.get(MARKITDOWN_LLM_TEXT_FLAG) == "1"


def _default_markitdown_converter_factory() -> MarkItDownConverter:
    from markitdown import MarkItDown

    return MarkItDown()


def _configured_markitdown_timeout_seconds() -> float:
    raw_timeout = os.environ.get(MARKITDOWN_TIMEOUT_SECONDS_FLAG)
    if raw_timeout is None:
        return DEFAULT_MARKITDOWN_TIMEOUT_SECONDS
    try:
        timeout = float(raw_timeout)
    except ValueError:
        return DEFAULT_MARKITDOWN_TIMEOUT_SECONDS
    return timeout if timeout > 0 else DEFAULT_MARKITDOWN_TIMEOUT_SECONDS


def _temporary_upload_suffix(filename: str) -> str:
    suffix = Path(filename or "").suffix.lower()
    return suffix if suffix in {".pdf", ".docx"} else ""


def _run_markitdown_with_timeout(
    *,
    path: Path,
    converter_factory: MarkItDownConverterFactory,
    timeout_seconds: float,
) -> str | None:
    results: Queue[tuple[str, str | BaseException | None]] = Queue(maxsize=1)

    def _target() -> None:
        try:
            converter = converter_factory()
            converted = converter.convert(str(path))
            results.put(("ok", getattr(converted, "text_content", None)))
        except Exception as exc:
            results.put(("error", exc))

    thread = threading.Thread(target=_target, daemon=True)
    thread.start()
    thread.join(timeout_seconds)
    if thread.is_alive():
        return None

    try:
        status, value = results.get_nowait()
    except Empty:
        return None
    if status == "error":
        if isinstance(value, BaseException):
            raise value
        return None
    return value if isinstance(value, str) else None


def _extract_markitdown_llm_text(
    *,
    filename: str,
    data: bytes,
    converter_factory: MarkItDownConverterFactory | None,
    timeout_seconds: float | None,
) -> str | None:
    if not _is_markitdown_enabled():
        return None

    resolved_converter_factory = converter_factory or _default_markitdown_converter_factory
    resolved_timeout = timeout_seconds or _configured_markitdown_timeout_seconds()

    try:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / f"upload{_temporary_upload_suffix(filename)}"
            path.write_bytes(data)
            return _run_markitdown_with_timeout(
                path=path,
                converter_factory=resolved_converter_factory,
                timeout_seconds=resolved_timeout,
            )
    except Exception:
        return None


def extract_text(
    *,
    filename: str,
    content_type: str,
    data: bytes,
    markitdown_converter_factory: MarkItDownConverterFactory | None = None,
    markitdown_timeout_seconds: float | None = None,
) -> ExtractionResult:
    if not data:
        raise ExtractionError("Uploaded file is empty")

    normalized_type = (content_type or "").split(";")[0].strip().lower()
    lowered_name = (filename or "").lower()

    if normalized_type in PDF_CONTENT_TYPES or lowered_name.endswith(".pdf"):
        pages, full_text, sections = _extract_pdf(data)
        resolved_type = RESOLVED_PDF_CONTENT_TYPE
    elif normalized_type in DOCX_CONTENT_TYPES or lowered_name.endswith(".docx"):
        pages, full_text = _extract_docx(data)
        resolved_type = RESOLVED_DOCX_CONTENT_TYPE
        sections = []
    else:
        raise UnsupportedContentTypeError(
            f"Unsupported content type '{content_type}' for file '{filename}'"
        )

    llm_text = _extract_markitdown_llm_text(
        filename=filename,
        data=data,
        converter_factory=markitdown_converter_factory,
        timeout_seconds=markitdown_timeout_seconds,
    )

    return ExtractionResult(
        filename=filename or "upload",
        content_type=resolved_type,
        page_count=len(pages),
        pages=pages,
        full_text=full_text,
        sections=sections,
        llm_text=llm_text,
    )
