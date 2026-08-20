"""Spanish filler-word / muletilla detection (design.md D8): a plain
lexicon/regex match over extracted page text, zero LLM calls (spec:
Filler Word Detection).
"""
from __future__ import annotations

import re

from .base import RuleFinding

CONFIDENCE = 0.90
RULE_ID = "filler_words.lexicon_match"
# thesis-normative-governance design.md D3: writing-style guidance is
# grounded in the Facultad "Guía para Trabajo de Graduación" (tier 3).
NORMATIVE_SOURCE_TYPE = "gt_guide"

# Conservative, common Spanish academic-writing muletillas — false-positive
# averse: every entry is a multi-word phrase or an unambiguous discourse
# filler, never a single common word that could be load-bearing elsewhere.
FILLER_LEXICON: tuple[str, ...] = (
    "o sea",
    "es decir que",
    "cabe mencionar que",
    "en ese sentido",
    "de alguna manera",
    "por así decirlo",
    "como quien dice",
    "a grosso modo",
    "en cierto modo",
    "digamos que",
    "de cierta forma",
    "por decirlo así",
)

_FILLER_PATTERNS: tuple[tuple[str, re.Pattern], ...] = tuple(
    (word, re.compile(re.escape(word), re.IGNORECASE)) for word in FILLER_LEXICON
)


def check(pages: list[dict], sections: list[dict] | None = None) -> list[RuleFinding]:
    findings: list[RuleFinding] = []
    for page in pages:
        text = page.get("text") or ""
        if not text:
            continue
        page_number = page.get("page_number")
        for word, pattern in _FILLER_PATTERNS:
            match = pattern.search(text)
            if not match:
                continue
            literal = match.group(0)
            findings.append(
                RuleFinding(
                    finding_type="writing_style",
                    severity="low",
                    confidence=CONFIDENCE,
                    title=f'Muletilla detectada: "{literal}"',
                    explanation=(
                        f'Se encontró la muletilla "{literal}", que debilita el '
                        "registro académico del texto."
                    ),
                    recommendation="Reformule la oración evitando esta muletilla.",
                    evidence_text=literal,
                    page_number=page_number,
                    section_index=None,
                    rule_id=RULE_ID,
                    metadata={"filler": word},
                )
            )
    return findings
