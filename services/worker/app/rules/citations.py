"""In-text-citation-vs-reference-list cross-check (design.md D8, spec:
Citation-vs-Reference Cross-Check). Pure regex — extracts APA-shaped
in-text citations `(Author, YYYY)` and reference-list entries
`Author, X. (YYYY).`, then flags each direction's mismatch.
"""
from __future__ import annotations

import re

from .base import RuleFinding, fold

CONFIDENCE = 0.80
UNCITED_REFERENCE_RULE_ID = "citations.uncited_reference_missing"
UNUSED_REFERENCE_RULE_ID = "citations.unused_reference_entry"
# thesis-normative-governance design.md D3: citation rules are grounded in
# the APA 6 manual (tier 2). Declared here (PR1, "governance spine") ahead
# of the PR2 APA-6 rule additions (et-al./quote-length checks, design.md
# D6) because `run_rules()`'s stamping loop (D3) reads this constant via
# unconditional `getattr()` on EVERY currently-registered module, including
# this one — omitting it would raise AttributeError on every `run_rules()`
# call and break the existing citation cross-check, not just gate future
# rules.
NORMATIVE_SOURCE_TYPE = "apa_6"

_AUTHOR_TOKEN = r"[A-ZÁÉÍÓÚÑ][\w'-]+"
_IN_TEXT_CITATION_PATTERN = re.compile(
    rf"\(({_AUTHOR_TOKEN}(?:\s*(?:&|y|et\s+al\.?)\s*{_AUTHOR_TOKEN})?),?\s*(\d{{4}})\)"
)
_REFERENCE_ENTRY_PATTERN = re.compile(rf"^({_AUTHOR_TOKEN}),.*?\((\d{{4}})\)")


def _citation_key(author: str, year: str) -> tuple[str, str]:
    first_author = re.split(r"\s*(?:&|y|et\s+al\.?)\s*", author)[0]
    return fold(first_author), year


def _reference_pages(sections: list[dict] | None) -> set[int]:
    """Page numbers inside a detected `references`-typed section — scopes
    reference-entry scanning to the reference list itself (and excludes it
    from in-text citation scanning, since a reference entry's own `(YYYY)`
    is not an in-text citation). Falls back to scanning every page for both
    when no `references` section was detected — never crashes, never
    fabricates a boundary."""
    reference_pages: set[int] = set()
    for section in sections or []:
        if section.get("section_type") != "references":
            continue
        start = section.get("start_page_number")
        end = section.get("end_page_number") or start
        if start is None:
            continue
        for page_number in range(start, end + 1):
            reference_pages.add(page_number)
    return reference_pages


def check(pages: list[dict], sections: list[dict] | None = None) -> list[RuleFinding]:
    reference_pages = _reference_pages(sections)

    citations: dict[tuple[str, str], dict] = {}
    reference_entries: dict[tuple[str, str], dict] = {}

    for page in pages:
        text = page.get("text") or ""
        if not text:
            continue
        page_number = page.get("page_number")
        in_reference_block = bool(reference_pages) and page_number in reference_pages

        if not in_reference_block:
            for match in _IN_TEXT_CITATION_PATTERN.finditer(text):
                key = _citation_key(match.group(1), match.group(2))
                citations.setdefault(
                    key, {"text": match.group(0), "page_number": page_number}
                )

        if reference_pages and not in_reference_block:
            continue
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            match = _REFERENCE_ENTRY_PATTERN.match(stripped)
            if not match:
                continue
            key = _citation_key(match.group(1), match.group(2))
            reference_entries.setdefault(
                key, {"text": stripped, "page_number": page_number}
            )

    findings: list[RuleFinding] = []

    for key, citation in citations.items():
        if key in reference_entries:
            continue
        findings.append(
            RuleFinding(
                finding_type="apa",
                severity="medium",
                confidence=CONFIDENCE,
                title=f'Cita sin referencia: "{citation["text"]}"',
                explanation=(
                    f'La cita en texto "{citation["text"]}" no tiene una entrada '
                    "correspondiente en la lista de referencias."
                ),
                recommendation=(
                    "Agregue la entrada correspondiente en la lista de "
                    "referencias, o corrija la cita."
                ),
                evidence_text=citation["text"],
                page_number=citation["page_number"],
                section_index=None,
                rule_id=UNCITED_REFERENCE_RULE_ID,
                metadata={"author_year": list(key)},
            )
        )

    for key, entry in reference_entries.items():
        if key in citations:
            continue
        findings.append(
            RuleFinding(
                finding_type="apa",
                severity="low",
                confidence=CONFIDENCE,
                title=f'Referencia no citada: "{entry["text"]}"',
                explanation=(
                    f'La entrada de la lista de referencias "{entry["text"]}" no '
                    "se encontró citada en ningún punto del texto."
                ),
                recommendation="Cite la referencia en el texto o elimínela de la lista.",
                evidence_text=entry["text"],
                page_number=entry["page_number"],
                section_index=None,
                rule_id=UNUSED_REFERENCE_RULE_ID,
                metadata={"author_year": list(key)},
            )
        )

    return findings
