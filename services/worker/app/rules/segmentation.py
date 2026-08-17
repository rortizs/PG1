"""Real Spanish sentence segmentation (design.md D8, D2's sibling decision).

Uses `pysbd` (`language="es"`) instead of naive `.`-splitting, which breaks
on abbreviations like "Dr." — pure-Python, no model download (design
rejected spaCy + `es_core_news_sm` specifically to avoid a ~45MB model
dependency for a sentencizer; see design.md's D8 rationale).
"""
from __future__ import annotations

import pysbd

_segmenter: pysbd.Segmenter | None = None


def _get_segmenter() -> pysbd.Segmenter:
    global _segmenter
    if _segmenter is None:
        _segmenter = pysbd.Segmenter(language="es", clean=False)
    return _segmenter


def sentences(text: str) -> list[str]:
    """Splits `text` into real sentences, never on a bare `.` after an
    abbreviation (e.g. "Dr. García" stays inside one sentence). Returns an
    empty list for empty/whitespace-only input — never crashes."""
    if not text or not text.strip():
        return []
    return [s.strip() for s in _get_segmenter().segment(text) if s and s.strip()]
