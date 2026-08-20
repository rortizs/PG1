"""Reglamento de Tesis structural checks (thesis-normative-governance
design.md D5, spec: Reglamento Structure Rules). Text-only:
`extraction.py` uses `pypdf`/`python-docx` and carries no layout
metadata, so this module is deliberately scoped to what plain extracted
text can prove — the required preliminary-page sequence and the verbatim
Artículo 8° responsibility text. See `NOT_COVERED` below (design.md D8)
for the non-goals this module MUST NOT claim, enforced structurally by
`tests/test_rules.py::NonGoalsStructuralGuardTest`, not just this
docstring.

Grounded in `data/academic-rules/lineamientos_ingenieria_sistemas.txt`
(Reglamento de Tesis, Capítulo IV, Artículos 8, 30-37, 50).

**Input**: `pages` only. Deliberately not `sections` — heading detection
targets body chapters, and preliminary pages carry no reliable heading
shape (design.md D5).
"""
from __future__ import annotations

import difflib

from .base import RuleFinding, squeeze

CONFIDENCE_PRELIMINARY = 0.75
CONFIDENCE_ARTICULO_8 = 0.90
MISSING_PRELIMINARY_PAGE_RULE_ID = "reglamento_structure.missing_preliminary_page"
PRELIMINARY_PAGE_OUT_OF_ORDER_RULE_ID = "reglamento_structure.preliminary_page_out_of_order"
ARTICULO_8_MISSING_RULE_ID = "reglamento_structure.articulo_8_missing"
ARTICULO_8_ALTERED_RULE_ID = "reglamento_structure.articulo_8_altered"
ARTICULO_8_MATCH_RATIO = 0.85

# thesis-normative-governance design.md D3: this module is grounded in the
# library Reglamento de Tesis (tier 1) -- the highest-precedence normative
# source. NOT set on findings by the module itself; run_rules() is the
# single choke point that stamps it (see base.py's RuleFinding docstring).
NORMATIVE_SOURCE_TYPE = "reglamento_tesis"

PRELIMINARY_SCAN_PAGES = 8  # models occupy 6 pages; +2 tolerance for guardas (Art. 32)

REQUIRED_ARTICLE_8_TEXT = (
    "Solamente el autor es responsable de los conceptos expresados en el trabajo de tesis. "
    "Su aprobación en manera alguna implica responsabilidad para la Universidad."
)

# (label, alternative marker phrases — any one matching a page's squeezed
# text satisfies that element). Order is the Reglamento-required order.
PRELIMINARY_SEQUENCE: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("carátula exterior", ("universidad mariano galvez de guatemala",)),
    ("carátula interior", ("previo a optar al grado academico",)),
    ("autoridades y tribunal", ("autoridades de la facultad", "decano de la facultad")),
    ("autorización de impresión", ("orden de impresion",)),
    ("artículo 8 (responsabilidad)", ("articulo 8", "reglamento de tesis")),
    ("índice", ("indice",)),
)

# thesis-normative-governance design.md D8: physical-layout requirements
# this module MUST NOT claim to evaluate — text-only extraction carries no
# layout metadata. Enforced structurally, not just documented here, by
# `tests/test_rules.py::NonGoalsStructuralGuardTest` scanning every
# registered module's `*_RULE_ID` constants for these tokens.
NOT_COVERED = (
    "márgenes (Art. 30/31)",
    "interlineado",
    "tipografía y tamaño de fuente",
    "posición de la paginación (Art. 37/50)",
    "sangría francesa",
    "cursivas",
    "fidelidad visual de portada/contraportada (escudo 11cm, cartulina) — "
    "permanentemente fuera de alcance automatizable, corresponde a la "
    "revisión física de biblioteca",
)


def _sorted_pages(pages: list[dict]) -> list[dict]:
    return sorted(pages, key=lambda page: page.get("page_number") or 0)


def _find_preliminary_elements(scan_pages: list[dict]) -> dict[int, dict]:
    """Returns `{element_index: {"page_number", "text"}}` for the earliest
    page (in document order) whose squeezed text contains any marker phrase
    for that `PRELIMINARY_SEQUENCE` element."""
    found: dict[int, dict] = {}
    for page in scan_pages:
        text = page.get("text") or ""
        if not text:
            continue
        squeezed_page = squeeze(text)
        for index, (_label, markers) in enumerate(PRELIMINARY_SEQUENCE):
            if index in found:
                continue
            if any(squeeze(marker) in squeezed_page for marker in markers):
                found[index] = {"page_number": page.get("page_number"), "text": text.strip()}
    return found


def _detected_summary(found: dict[int, dict]) -> str:
    ordered = sorted(found.items(), key=lambda item: item[1]["page_number"] or 0)
    if not ordered:
        return "(ninguna página preliminar detectada)"
    return "; ".join(
        f"{PRELIMINARY_SEQUENCE[index][0]} (p.{data['page_number']})"
        for index, data in ordered
    )


def _check_preliminary_sequence(pages: list[dict]) -> list[RuleFinding]:
    scan_pages = _sorted_pages(pages)[:PRELIMINARY_SCAN_PAGES]
    found = _find_preliminary_elements(scan_pages)
    detected_summary = _detected_summary(found)

    findings: list[RuleFinding] = []

    for index, (label, _markers) in enumerate(PRELIMINARY_SEQUENCE):
        if index in found:
            continue
        findings.append(
            RuleFinding(
                finding_type="structure",
                severity="medium",
                confidence=CONFIDENCE_PRELIMINARY,
                title=f'Página preliminar ausente: "{label}"',
                explanation=(
                    f'El Reglamento de Tesis (Capítulo IV) exige la página "{label}" '
                    "entre las páginas preliminares, y no fue detectada."
                ),
                recommendation=f'Agregue la página "{label}" en la secuencia preliminar.',
                evidence_text=detected_summary,
                page_number=None,
                section_index=None,
                rule_id=MISSING_PRELIMINARY_PAGE_RULE_ID,
                metadata={"missing_element": label},
            )
        )

    ordered_found = sorted(found.items(), key=lambda item: item[0])
    page_numbers = [data["page_number"] for _index, data in ordered_found]
    is_ordered = all(
        page_numbers[i] is None
        or page_numbers[i + 1] is None
        or page_numbers[i] <= page_numbers[i + 1]
        for i in range(len(page_numbers) - 1)
    )
    if ordered_found and not is_ordered:
        findings.append(
            RuleFinding(
                finding_type="structure",
                severity="low",
                confidence=CONFIDENCE_PRELIMINARY,
                title="Páginas preliminares fuera de orden",
                explanation=(
                    "El Reglamento de Tesis exige el orden: carátula exterior, "
                    "carátula interior, autoridades y tribunal, autorización de "
                    "impresión, hoja con el Artículo 8°, índice. El orden "
                    "detectado no respeta esa secuencia."
                ),
                recommendation="Reordene las páginas preliminares según el Reglamento.",
                evidence_text=detected_summary,
                page_number=None,
                section_index=None,
                rule_id=PRELIMINARY_PAGE_OUT_OF_ORDER_RULE_ID,
                metadata={"detected_order": detected_summary},
            )
        )

    return findings


def _check_articulo_8(pages: list[dict]) -> list[RuleFinding]:
    required_squeezed = squeeze(REQUIRED_ARTICLE_8_TEXT)
    best_ratio = 0.0
    best_page: dict | None = None

    for page in pages:
        text = page.get("text") or ""
        if not text:
            continue
        squeezed_page = squeeze(text)
        if required_squeezed in squeezed_page:
            return []  # exact verbatim match found -- no finding
        ratio = difflib.SequenceMatcher(None, required_squeezed, squeezed_page).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_page = page

    if best_ratio >= ARTICULO_8_MATCH_RATIO and best_page is not None:
        return [
            RuleFinding(
                finding_type="structure",
                severity="high",
                confidence=CONFIDENCE_ARTICULO_8,
                title="Artículo 8° presente pero alterado",
                explanation=(
                    "El texto del Artículo 8° (Responsabilidad) detectado difiere "
                    "del texto exacto exigido por el Reglamento de Tesis."
                ),
                recommendation=(
                    "Restituya el texto exacto del Artículo 8° del Reglamento de Tesis."
                ),
                evidence_text=(best_page.get("text") or "").strip(),
                page_number=best_page.get("page_number"),
                section_index=None,
                rule_id=ARTICULO_8_ALTERED_RULE_ID,
                metadata={"match_ratio": round(best_ratio, 4)},
            )
        ]

    evidence = (
        (best_page.get("text") or "").strip() if best_page is not None else "(no se detectó texto)"
    )
    return [
        RuleFinding(
            finding_type="structure",
            severity="high",
            confidence=CONFIDENCE_ARTICULO_8,
            title="Artículo 8° ausente",
            explanation=(
                "El texto exigido del Artículo 8° (Responsabilidad) del Reglamento "
                "de Tesis no fue encontrado en el documento."
            ),
            recommendation="Incluya el texto exacto del Artículo 8° del Reglamento de Tesis.",
            evidence_text=evidence,
            page_number=best_page.get("page_number") if best_page is not None else None,
            section_index=None,
            rule_id=ARTICULO_8_MISSING_RULE_ID,
            metadata={"match_ratio": round(best_ratio, 4)},
        )
    ]


def check(pages: list[dict], sections: list[dict] | None = None) -> list[RuleFinding]:
    del sections  # design.md D5: deliberately unused -- see module docstring
    if not pages:
        return []
    # design.md's explicit invariant, mirroring gt_structure.py's
    # zero-evidence skip: fewer than PRELIMINARY_SCAN_PAGES pages with no
    # text at all -> skipped entirely, no evidence, no finding.
    if len(pages) < PRELIMINARY_SCAN_PAGES and not any(
        (page.get("text") or "").strip() for page in pages
    ):
        return []
    return _check_preliminary_sequence(pages) + _check_articulo_8(pages)
