"""Claude-backed CAG (corpus-augmented generation) thesis review.

Builds ONE prompt containing the full static normative corpus
(`data/academic-rules/*.txt`, ~1,300 lines) plus the extracted thesis
excerpt, sends it through an `LLMProvider`, and parses a strict JSON
response into zero-or-one grounded finding. The corpus is small enough to
fit in a single context window, so no chunking/embeddings are used here.

Never fabricates a finding: if the provider says nothing is grounded
(`{"finding": null}`), the result is `None`. If the provider response cannot
be parsed as the expected JSON shape, `CagReviewError` is raised explicitly
— a parse failure is never silently treated as "no finding", since that
would hide a real failure behind a false-clean result.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .providers.llm_provider import LLMProvider

# services/worker/app/cag_review.py -> parents[3] is the repo root.
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CORPUS_DIR = REPO_ROOT / "data" / "academic-rules"

REQUIRED_FINDING_FIELDS = (
    "title",
    "explanation",
    "recommendation",
    "evidence_text",
    "normative_source_ref",
)

SYSTEM_PROMPT = (
    "You are an academic-thesis compliance reviewer. You are given the full "
    "text of the normative corpus (institutional rules/guidelines) and an "
    "excerpt from a student's thesis. Identify AT MOST ONE issue where the "
    "thesis excerpt clearly violates a rule stated in the normative corpus. "
    "You MUST ground every claim in the literal text of the excerpt or the "
    "corpus — never invent an issue that is not textually supported. If you "
    "cannot ground a violation, respond with exactly {\"finding\": null}. "
    "Respond with ONLY a single JSON object, no prose, no markdown fences, "
    "matching this exact shape:\n"
    '{"finding": null} OR {"finding": {'
    '"title": string, "explanation": string, "recommendation": string, '
    '"evidence_text": string (verbatim excerpt from the thesis text), '
    '"page_number": number|null, "section_title": string|null, '
    '"normative_source_ref": string (the corpus filename the rule came from), '
    '"severity": "low"|"medium"|"high"|"critical", '
    '"confidence": number between 0 and 1}}'
)


class CagReviewError(RuntimeError):
    """Raised when the provider response cannot be trusted — never fabricated."""


@dataclass(frozen=True)
class CagFinding:
    finding_type: str
    severity: str
    confidence: float
    title: str
    explanation: str
    recommendation: str
    evidence_text: str
    page_number: int | None
    section_title: str | None
    normative_source_ref: str
    producer_type: str
    producer_id: str


def load_corpus(corpus_dir: Path = DEFAULT_CORPUS_DIR) -> str:
    """Concatenate every `.txt` file in the corpus directory, sorted by name."""
    files = sorted(corpus_dir.glob("*.txt"))
    if not files:
        raise CagReviewError(f"No normative corpus files found in {corpus_dir}")
    sections = [
        f"### SOURCE: {path.name}\n{path.read_text(encoding='utf-8')}" for path in files
    ]
    return "\n\n".join(sections)


def build_prompt(
    corpus_text: str,
    thesis_text: str,
    retrieved_context: list[dict[str, Any]] | None = None,
) -> str:
    if retrieved_context:
        context_text = "\n\n".join(
            f"### SOURCE: {item.get('source_ref', 'unknown')}\n{item.get('segment_text', '')}"
            for item in retrieved_context
        )
        return (
            f"{SYSTEM_PROMPT}\n\n"
            f"=== RETRIEVED NORMATIVE CONTEXT ===\n{context_text}\n\n"
            f"=== THESIS EXCERPT ===\n{thesis_text}\n"
        )
    return (
        f"{SYSTEM_PROMPT}\n\n"
        f"=== NORMATIVE CORPUS ===\n{corpus_text}\n\n"
        f"=== THESIS EXCERPT ===\n{thesis_text}\n"
    )


def _parse_response(raw: str) -> dict[str, Any]:
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        raise CagReviewError(f"Provider returned non-JSON response: {exc}") from exc
    if not isinstance(payload, dict) or "finding" not in payload:
        raise CagReviewError("Provider JSON response missing required 'finding' key")
    return payload


def _coerce_confidence(value: Any) -> float:
    if value in (None, ""):
        return 0.5
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise CagReviewError("Provider finding confidence must be numeric") from exc


def run_cag_review(
    provider: LLMProvider,
    thesis_text: str,
    *,
    corpus_dir: Path = DEFAULT_CORPUS_DIR,
    model_label: str = "claude",
    retrieved_context: list[dict[str, Any]] | None = None,
) -> CagFinding | None:
    corpus_text = "" if retrieved_context else load_corpus(corpus_dir)
    prompt = build_prompt(corpus_text, thesis_text, retrieved_context)
    raw = provider.generate(prompt)
    payload = _parse_response(raw)

    finding = payload["finding"]
    if finding is None:
        return None
    if not isinstance(finding, dict):
        # pi-lens-ignore: unchecked-throwing-call-python
        raise CagReviewError("Provider 'finding' must be an object or null")

    missing = [field for field in REQUIRED_FINDING_FIELDS if not finding.get(field)]
    if missing:
        raise CagReviewError(f"Provider finding missing required fields: {missing}")

    return CagFinding(
        finding_type="rag_review",
        severity=finding.get("severity") or "medium",
        confidence=_coerce_confidence(finding.get("confidence")),
        title=finding["title"],
        explanation=finding["explanation"],
        recommendation=finding["recommendation"],
        evidence_text=finding["evidence_text"],
        page_number=finding.get("page_number"),
        section_title=finding.get("section_title"),
        normative_source_ref=finding["normative_source_ref"],
        producer_type="controlled_rag",
        producer_id=f"{model_label}",
    )
