"""GT structure-presence check (design.md D8, spec: GT Structure Presence
Check). Compares detected `document_section` headings against the expected
structure grounded in the corpus — verified in
`data/academic-rules/tesis_guia_trabajo_gt.txt:598-685`,
`plantilla_sugerida_trabajo_graduacion.txt:39-106`,
`ejemplo_para_guia.txt:202` (design.md D8).
"""
from __future__ import annotations

from .base import RuleFinding, fold

CONFIDENCE = 0.85
RULE_ID = "gt_structure.missing_required_section"
# thesis-normative-governance design.md D3: this module is grounded in the
# Facultad "Guía para Trabajo de Graduación" corpus files (tier 3).
NORMATIVE_SOURCE_TYPE = "gt_guide"

# Each tuple is a group of acceptable synonyms for one required GT section —
# any one of them being present satisfies that requirement (e.g.
# "bibliografia" OR "referencias").
EXPECTED_STRUCTURE: tuple[tuple[str, ...], ...] = (
    ("introduccion",),
    ("marco teorico",),
    ("marco metodologico",),
    ("conclusiones",),
    ("recomendaciones",),
    ("bibliografia", "referencias"),
    ("anexos", "anexo"),
)


def check(pages: list[dict], sections: list[dict] | None = None) -> list[RuleFinding]:
    sections = sections or []
    if not sections:
        # design.md's explicit invariant: zero detected sections -> skipped
        # entirely, no evidence, no finding (never fabricated).
        return []

    titles = [section.get("title") for section in sections if section.get("title")]
    detected_normalized = {
        fold(section.get("normalized_title") or section.get("title") or "")
        for section in sections
    }
    evidence_text = "; ".join(titles) if titles else "(sin secciones detectadas)"

    findings: list[RuleFinding] = []
    for group in EXPECTED_STRUCTURE:
        found = any(
            any(keyword in normalized for keyword in group)
            for normalized in detected_normalized
            if normalized
        )
        if found:
            continue
        label = " / ".join(group)
        findings.append(
            RuleFinding(
                finding_type="gt",
                severity="high",
                confidence=CONFIDENCE,
                title=f'Sección requerida ausente: "{label}"',
                explanation=(
                    f'La estructura normativa (GT) exige una sección "{label}" '
                    "que no fue detectada entre las secciones del documento."
                ),
                recommendation=(
                    f'Agregue una sección "{label}" siguiendo la guía de '
                    "trabajos de graduación."
                ),
                evidence_text=evidence_text,
                page_number=None,
                section_index=None,
                rule_id=RULE_ID,
                metadata={
                    "expected": list(group),
                    "detected_sections": sorted(t for t in detected_normalized if t),
                },
            )
        )
    return findings
