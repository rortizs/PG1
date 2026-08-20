"""Long-sentence detection via real sentence segmentation (design.md D8,
spec: Long Sentence Detection via Real Sentence Segmentation).
"""
from __future__ import annotations

from .base import RuleFinding
from .segmentation import sentences

WORD_THRESHOLD = 40
CONFIDENCE = 0.85
RULE_ID = "long_sentences.word_count_threshold"
# thesis-normative-governance design.md D3: writing-style guidance is
# grounded in the Facultad "Guía para Trabajo de Graduación" (tier 3).
NORMATIVE_SOURCE_TYPE = "gt_guide"


def check(pages: list[dict], sections: list[dict] | None = None) -> list[RuleFinding]:
    findings: list[RuleFinding] = []
    for page in pages:
        text = page.get("text") or ""
        if not text.strip():
            continue
        page_number = page.get("page_number")
        for sentence in sentences(text):
            words = sentence.split()
            if len(words) <= WORD_THRESHOLD:
                continue
            findings.append(
                RuleFinding(
                    finding_type="writing_style",
                    severity="low",
                    confidence=CONFIDENCE,
                    title="Oración demasiado larga",
                    explanation=(
                        f"La oración tiene {len(words)} palabras, superando el "
                        f"umbral recomendado de {WORD_THRESHOLD}."
                    ),
                    recommendation="Divida la oración en unidades más cortas y claras.",
                    evidence_text=sentence,
                    page_number=page_number,
                    section_index=None,
                    rule_id=RULE_ID,
                    metadata={"word_count": len(words), "threshold": WORD_THRESHOLD},
                )
            )
    return findings
