"""Spanish spelling check (design.md D8, spec: Spanish Spelling Check).

Uses `pyspellchecker`'s bundled Spanish dictionary. Conservative
false-positive-averse gate (design.md D8): a token is flagged only when it
(1) fails the dictionary, (2) is lowercase, (3) has length >= 4,
(4) is not an acronym, (5) contains no digits, and (6) is not inside a
detected reference/citation span (approximated by the same
`(Author, YYYY)`-shaped span `citations.py` matches — spelling never flags
inside a citation).
"""
from __future__ import annotations

import re

from spellchecker import SpellChecker

from .base import RuleFinding

CONFIDENCE = 0.75
RULE_ID = "spelling.dictionary_miss"
MIN_TOKEN_LENGTH = 4
# thesis-normative-governance design.md D3: writing-style guidance is
# grounded in the Facultad "Guía para Trabajo de Graduación" (tier 3).
NORMATIVE_SOURCE_TYPE = "gt_guide"
CONTEXT_RADIUS = 30

_TOKEN_PATTERN = re.compile(r"[A-Za-zÁÉÍÓÚÑÜáéíóúñü]+")
_CITATION_SPAN_PATTERN = re.compile(r"\([^)]*\d{4}[^)]*\)")

_spellchecker: SpellChecker | None = None


def _get_spellchecker() -> SpellChecker:
    global _spellchecker
    if _spellchecker is None:
        _spellchecker = SpellChecker(language="es")
    return _spellchecker


def _is_acronym(token: str) -> bool:
    return token.isupper() and len(token) > 1


def _inside_citation_span(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    return any(start < c_end and end > c_start for c_start, c_end in spans)


def check(pages: list[dict], sections: list[dict] | None = None) -> list[RuleFinding]:
    spell = _get_spellchecker()
    findings: list[RuleFinding] = []
    for page in pages:
        text = page.get("text") or ""
        if not text:
            continue
        page_number = page.get("page_number")
        citation_spans = [m.span() for m in _CITATION_SPAN_PATTERN.finditer(text)]

        for match in _TOKEN_PATTERN.finditer(text):
            token = match.group(0)
            if not token.islower() or len(token) < MIN_TOKEN_LENGTH:
                continue
            if _is_acronym(token) or any(ch.isdigit() for ch in token):
                continue
            start, end = match.span()
            if _inside_citation_span(start, end, citation_spans):
                continue
            if token in spell:
                continue

            context_start = max(0, start - CONTEXT_RADIUS)
            context_end = min(len(text), end + CONTEXT_RADIUS)
            findings.append(
                RuleFinding(
                    finding_type="writing_style",
                    severity="low",
                    confidence=CONFIDENCE,
                    title=f'Posible error ortográfico: "{token}"',
                    explanation=(
                        f'El término "{token}" no se encontró en el diccionario '
                        "español configurado."
                    ),
                    recommendation="Verifique la ortografía del término.",
                    evidence_text=text[context_start:context_end].strip(),
                    page_number=page_number,
                    section_index=None,
                    rule_id=RULE_ID,
                    metadata={"token": token},
                )
            )
    return findings
