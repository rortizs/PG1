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

# thesis-normative-governance design.md D6: APA 6 et-al./quote-length
# additions. A SECOND, INDEPENDENT scanner over the same extracted text —
# the cross-check patterns above are untouched (design.md D6: restructuring
# the existing first-author+year keying would risk regressing passing
# tests for zero benefit).
ET_AL_REQUIRED_SIX_AUTHORS_RULE_ID = "citations.et_al_required_six_authors"
ET_AL_REQUIRED_AFTER_FIRST_MENTION_RULE_ID = "citations.et_al_required_after_first_mention"
ET_AL_ON_TWO_AUTHOR_SOURCE_RULE_ID = "citations.et_al_on_two_author_source"
LONG_QUOTE_NOT_BLOCK_RULE_ID = "citations.long_quote_not_block"

ET_AL_SIX_AUTHORS_CONFIDENCE = 0.85
ET_AL_AFTER_FIRST_MENTION_CONFIDENCE = 0.80
ET_AL_TWO_AUTHOR_SOURCE_CONFIDENCE = 0.75
LONG_QUOTE_CONFIDENCE = 0.80

LONG_QUOTE_WORD_THRESHOLD = 40
# ReDoS guard (design.md D6, threat matrix): a bounded quantifier on the
# quoted-span character class means an unmatched quotation mark can never
# swallow the rest of a page — the match simply fails past this bound
# instead of scanning unboundedly.
MAX_QUOTE_SPAN_CHARS = 2000

_AUTHOR_TOKEN_PATTERN = re.compile(_AUTHOR_TOKEN)
# A fully-named author list ending in ", YYYY)" -- deliberately does NOT
# match "et al." (a literal "et al." right after the first author breaks
# this pattern, since neither the comma-group nor the &/y-group consumes
# " et al."), so this pattern only ever matches citations that spell out
# every author's surname.
_FULL_AUTHOR_GROUP_PATTERN = re.compile(
    rf"\(((?:{_AUTHOR_TOKEN}(?:,\s*{_AUTHOR_TOKEN})*)(?:,?\s*(?:&|y)\s*{_AUTHOR_TOKEN})?),"
    rf"\s*(\d{{4}})\)"
)
_ET_AL_CITATION_PATTERN = re.compile(rf"\(({_AUTHOR_TOKEN})\s+et\s+al\.?,?\s*(\d{{4}})\)")
_REFERENCE_AUTHOR_TOKEN_PATTERN = re.compile(rf"{_AUTHOR_TOKEN},\s*[A-ZÁÉÍÓÚÑ]\.")
_QUOTE_SPAN_PATTERN = re.compile(
    r'["“]([^"”]{1,%d})["”]' % MAX_QUOTE_SPAN_CHARS
)


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


def _reference_entries_by_key(
    pages: list[dict], sections: list[dict] | None
) -> dict[tuple[str, str], str]:
    """Independent reference-entry scan for the et-al. checks (design.md
    D6) — reuses the same shared helpers (`_reference_pages`,
    `_REFERENCE_ENTRY_PATTERN`, `_citation_key`) as the pre-existing
    cross-check above, but computes its own pass rather than touching
    that function's body."""
    reference_pages = _reference_pages(sections)
    entries: dict[tuple[str, str], str] = {}
    for page in pages:
        text = page.get("text") or ""
        if not text:
            continue
        page_number = page.get("page_number")
        in_reference_block = bool(reference_pages) and page_number in reference_pages
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
            entries.setdefault(key, stripped)
    return entries


def _check_et_al_and_quotes(
    pages: list[dict], sections: list[dict] | None
) -> list[RuleFinding]:
    findings: list[RuleFinding] = []
    reference_entries = _reference_entries_by_key(pages, sections)
    full_mention_counts: dict[tuple[str, str], int] = {}

    for page in pages:
        text = page.get("text") or ""
        if not text:
            continue
        page_number = page.get("page_number")

        for match in _FULL_AUTHOR_GROUP_PATTERN.finditer(text):
            author_list_text, year = match.group(1), match.group(2)
            author_tokens = _AUTHOR_TOKEN_PATTERN.findall(author_list_text)
            author_count = len(author_tokens)
            if author_count < 2:
                continue  # a bare single-author citation, nothing to threshold

            key = (fold(author_tokens[0]), year)
            occurrence = full_mention_counts.get(key, 0) + 1
            full_mention_counts[key] = occurrence
            citation_text = match.group(0)

            if author_count >= 6:
                findings.append(
                    RuleFinding(
                        finding_type="apa",
                        severity="medium",
                        confidence=ET_AL_SIX_AUTHORS_CONFIDENCE,
                        title="Cita de 6 o más autores sin abreviar con \"et al.\"",
                        explanation=(
                            f'La cita "{citation_text}" nombra {author_count} autores; '
                            'APA 6 exige usar "et al." desde la primera mención cuando '
                            "hay 6 o más autores."
                        ),
                        recommendation=(
                            f'Abrevie a "({author_tokens[0]} et al., {year})".'
                        ),
                        evidence_text=citation_text,
                        page_number=page_number,
                        section_index=None,
                        rule_id=ET_AL_REQUIRED_SIX_AUTHORS_RULE_ID,
                        metadata={"author_count": author_count, "author_year": list(key)},
                    )
                )
            elif 3 <= author_count <= 5 and occurrence >= 2:
                findings.append(
                    RuleFinding(
                        finding_type="apa",
                        severity="medium",
                        confidence=ET_AL_AFTER_FIRST_MENTION_CONFIDENCE,
                        title='Cita de 3-5 autores repetida sin "et al."',
                        explanation=(
                            f'La cita "{citation_text}" nombra {author_count} autores '
                            "nuevamente en su totalidad; APA 6 exige abreviar con "
                            '"et al." a partir de la segunda mención.'
                        ),
                        recommendation=(
                            f'Abrevie a "({author_tokens[0]} et al., {year})" a partir '
                            "de esta mención."
                        ),
                        evidence_text=citation_text,
                        page_number=page_number,
                        section_index=None,
                        rule_id=ET_AL_REQUIRED_AFTER_FIRST_MENTION_RULE_ID,
                        metadata={"author_count": author_count, "author_year": list(key)},
                    )
                )

        for match in _ET_AL_CITATION_PATTERN.finditer(text):
            first_author, year = match.group(1), match.group(2)
            key = _citation_key(first_author, year)
            reference_text = reference_entries.get(key)
            if not reference_text:
                continue  # design.md D6: only checkable when the entry resolves
            author_segment = reference_text.split("(", 1)[0]
            reference_author_count = len(
                _REFERENCE_AUTHOR_TOKEN_PATTERN.findall(author_segment)
            )
            if reference_author_count != 2:
                continue
            citation_text = match.group(0)
            findings.append(
                RuleFinding(
                    finding_type="apa",
                    severity="low",
                    confidence=ET_AL_TWO_AUTHOR_SOURCE_CONFIDENCE,
                    title='"et al." usado en fuente de solo dos autores',
                    explanation=(
                        f'La cita "{citation_text}" usa "et al.", pero la referencia '
                        f'correspondiente ("{reference_text}") nombra solo 2 autores; '
                        "APA 6 exige nombrar ambos siempre."
                    ),
                    recommendation=f"Nombre ambos autores: \"({reference_text.split('.')[0]}, {year})\".",
                    evidence_text=citation_text,
                    page_number=page_number,
                    section_index=None,
                    rule_id=ET_AL_ON_TWO_AUTHOR_SOURCE_RULE_ID,
                    metadata={"author_year": list(key)},
                )
            )

        for match in _QUOTE_SPAN_PATTERN.finditer(text):
            quoted_text = match.group(1)
            word_count = len(quoted_text.split())
            if word_count < LONG_QUOTE_WORD_THRESHOLD:
                continue
            findings.append(
                RuleFinding(
                    finding_type="apa",
                    severity="medium",
                    confidence=LONG_QUOTE_CONFIDENCE,
                    title="Cita textual larga sin formato de bloque",
                    explanation=(
                        f"La cita textual detectada tiene {word_count} palabras "
                        f"(umbral: {LONG_QUOTE_WORD_THRESHOLD}); APA 6 exige que las "
                        "citas de 40 palabras o más se presenten como cita en bloque, "
                        "sin comillas."
                    ),
                    recommendation="Presente esta cita como cita en bloque, sin comillas.",
                    evidence_text=quoted_text,
                    page_number=page_number,
                    section_index=None,
                    rule_id=LONG_QUOTE_NOT_BLOCK_RULE_ID,
                    metadata={"word_count": word_count},
                )
            )

    return findings


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

    # thesis-normative-governance design.md D6: APA 6 et-al./quote-length
    # additions run as a second, independent scanner appended here -- the
    # cross-check logic above is untouched.
    findings.extend(_check_et_al_and_quotes(pages, sections))

    return findings
