"""Real, minimal in-memory PDF/DOCX fixture builders for worker tests.

No binary fixture files are committed to the repo: these helpers build
genuinely parseable PDF/DOCX byte content on the fly (real `pypdf`/`python-docx`
readable files), so extraction tests exercise the real parsing libraries
end-to-end without bloating the diff with binary assets.
"""
from __future__ import annotations

import io


def build_minimal_pdf(text: str = "Hello Thesis Text") -> bytes:
    """Hand-assemble a minimal, valid, single-page PDF with real extractable text.

    Byte offsets in the xref table are computed programmatically (not
    hardcoded) so the file is a genuinely well-formed PDF that `pypdf` can
    parse without relying on its lenient-recovery fallback path.
    """
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> "
        b"/MediaBox [0 0 612 792] /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream_content = f"BT /F1 24 Tf 72 700 Td ({text}) Tj ET".encode("latin-1")
    objects.append(
        b"<< /Length %d >>\nstream\n" % len(stream_content)
        + stream_content
        + b"\nendstream"
    )

    pdf = bytearray()
    pdf += b"%PDF-1.4\n"
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref_offset = len(pdf)
    pdf += f"xref\n0 {len(objects) + 1}\n".encode()
    pdf += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        pdf += f"{offset:010d} 00000 n \n".encode()
    pdf += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF"
    ).encode()
    return bytes(pdf)


def build_minimal_docx(paragraphs: list[str] | None = None) -> bytes:
    """Build a real, valid DOCX file in memory using `python-docx`."""
    from docx import Document

    document = Document()
    for paragraph in paragraphs or ["Hello Thesis Text"]:
        document.add_paragraph(paragraph)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()
