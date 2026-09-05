"""Chunked, cache-aware CAG thesis review.

The worker owns the full-document review loop: it receives extracted pages and
sections, plans bounded chunks, calls the judgment provider once per chunk using
a stable cacheable normative-corpus block, filters untrusted candidates, dedups
adjacent duplicate findings, and returns a multi-finding result with stats.
"""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .providers.llm_provider import LLMProvider, PromptBlock

try:  # rapidfuzz is declared as a dependency for deployment, but keep tests usable locally.
    from rapidfuzz import fuzz as _rapidfuzz_fuzz  # type: ignore
except Exception:  # pragma: no cover - exercised implicitly when dependency is absent locally.
    _rapidfuzz_fuzz = None

# services/worker/app/cag_review.py -> parents[3] is the repo root.
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CORPUS_DIR = REPO_ROOT / "data" / "academic-rules"

MAX_CHUNK_PAGES = 8
MAX_CHUNK_CHARS = 24_000
CONTEXT_TAIL_CHARS = 800
MIN_LLM_CONFIDENCE = 0.75
GROUNDING_FUZZ_MIN = 95
DEDUP_MIN = 92

REQUIRED_FINDING_FIELDS = (
    "title",
    "explanation",
    "recommendation",
    "evidence_text",
    "normative_source_ref",
)

SYSTEM_PROMPT = (
    "You are an academic-thesis compliance reviewer. You are given the full "
    "text of the normative corpus (institutional rules/guidelines) and one "
    "bounded chunk from a student's thesis. Identify every issue in THIS CHUNK "
    "where the thesis text clearly violates a rule stated in the normative "
    "corpus. You MUST ground every claim in the literal chunk text or corpus — "
    "never invent an issue that is not textually supported. If a block is marked "
    "CONTEXT ONLY, use it only to understand continuity and DO NOT report "
    "findings from that block. If there are no grounded violations, respond with "
    "exactly {\"findings\": []}. Respond with ONLY a single JSON object, no "
    "prose, no markdown fences, matching this exact shape:\n"
    '{"findings": [{'
    '"title": string, "explanation": string, "recommendation": string, '
    '"evidence_text": string (verbatim excerpt from the thesis chunk), '
    '"page_number": number|null, "section_index": number|null, '
    '"normative_source_ref": string (the corpus filename the rule came from), '
    '"severity": "low"|"medium"|"high"|"critical", '
    '"confidence": number between 0 and 1}]}'
)

CONTEXT_LABEL = "CONTEXT ONLY — do not report findings from this block"


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
    section_index: int | None
    normative_source_ref: str
    producer_type: str
    producer_id: str
    metadata: dict[str, Any] = field(default_factory=dict)
    chunk_index: int | None = None


@dataclass(frozen=True)
class CagReviewResult:
    findings: list[CagFinding]
    stats: dict[str, int]


@dataclass(frozen=True)
class _Chunk:
    index: int
    text: str
    source_text: str
    page_numbers: list[int]
    section_index: int | None
    section_title: str | None


def load_corpus(corpus_dir: Path = DEFAULT_CORPUS_DIR) -> str:
    """Concatenate every `.txt` file in the corpus directory, sorted by name."""
    files = sorted(corpus_dir.glob("*.txt"))
    if not files:
        raise CagReviewError(f"No normative corpus files found in {corpus_dir}")
    sections = [
        f"### SOURCE: {path.name}\n{path.read_text(encoding='utf-8')}" for path in files
    ]
    return "\n\n".join(sections)


def build_system_blocks(corpus_text: str) -> list[PromptBlock]:
    return [
        PromptBlock(SYSTEM_PROMPT),
        PromptBlock(f"=== NORMATIVE CORPUS ===\n{corpus_text}", cacheable=True),
    ]


def _page_number(page: dict[str, Any]) -> int | None:
    value = page.get("page_number")
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _format_pages(pages: list[dict[str, Any]]) -> str:
    blocks: list[str] = []
    for page in pages:
        number = _page_number(page)
        label = f"Page {number}" if number is not None else "Page unknown"
        section_title = page.get("section_title")
        if section_title:
            label = f"{label} — {section_title}"
        blocks.append(f"[{label}]\n{page.get('text') or ''}".strip())
    return "\n\n".join(block for block in blocks if block)


def _with_context(source_text: str, previous_source_text: str | None) -> str:
    if not previous_source_text:
        return source_text
    tail = previous_source_text[-CONTEXT_TAIL_CHARS:]
    if not tail.strip():
        return source_text
    return f"{CONTEXT_LABEL}\n{tail}\n\nCURRENT CHUNK\n{source_text}"


def _split_dense_text(text: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    start = 0
    while start < len(text):
        parts.append(text[start : start + limit])
        start += limit
    return parts


def _chunk_from_pages(
    *,
    chunks: list[_Chunk],
    pages: list[dict[str, Any]],
    section_index: int | None,
    section_title: str | None,
    previous_source_text: str | None,
) -> str | None:
    source_text = _format_pages(pages)
    if not source_text:
        return previous_source_text
    split_parts = _split_dense_text(source_text)
    for part in split_parts:
        chunks.append(
            _Chunk(
                index=len(chunks),
                text=_with_context(part, previous_source_text),
                source_text=part,
                page_numbers=[n for n in (_page_number(page) for page in pages) if n is not None],
                section_index=section_index,
                section_title=section_title,
            )
        )
        previous_source_text = part
    return previous_source_text


def _plan_chunks(pages: list[dict[str, Any]], sections: list[dict[str, Any]]) -> list[_Chunk]:
    page_list = list(pages or [])
    chunks: list[_Chunk] = []
    previous_source_text: str | None = None

    if sections:
        by_number = {number: page for page in page_list if (number := _page_number(page)) is not None}
        for section in sorted(sections, key=lambda item: item.get("index", 0)):
            start = section.get("start_page_number")
            end = section.get("end_page_number") or start
            if start is None or end is None:
                continue
            try:
                start_number = int(start)
                end_number = int(end)
            except (TypeError, ValueError):
                continue
            section_pages = [
                by_number[number]
                for number in range(start_number, end_number + 1)
                if number in by_number
            ]
            for offset in range(0, len(section_pages), MAX_CHUNK_PAGES):
                previous_source_text = _chunk_from_pages(
                    chunks=chunks,
                    pages=section_pages[offset : offset + MAX_CHUNK_PAGES],
                    section_index=section.get("index"),
                    section_title=section.get("title"),
                    previous_source_text=previous_source_text,
                )
        return chunks

    for offset in range(0, len(page_list), MAX_CHUNK_PAGES):
        previous_source_text = _chunk_from_pages(
            chunks=chunks,
            pages=page_list[offset : offset + MAX_CHUNK_PAGES],
            section_index=None,
            section_title=None,
            previous_source_text=previous_source_text,
        )
    return chunks


def _parse_response(raw: str) -> dict[str, Any]:
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        raise CagReviewError(f"Provider returned non-JSON response: {exc}") from exc
    if not isinstance(payload, dict) or "findings" not in payload:
        raise CagReviewError("Provider JSON response missing required 'findings' key")
    if not isinstance(payload["findings"], list):
        raise CagReviewError("Provider 'findings' must be a list")
    return payload


def _coerce_confidence(value: Any) -> float:
    if value in (None, ""):
        return 0.5
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise CagReviewError("Provider finding confidence must be numeric") from exc


def _normalize_for_match(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value or "")
    collapsed = re.sub(r"\s+", " ", normalized).strip()
    return collapsed.casefold()


def _partial_ratio(candidate: str, source: str) -> float:
    if _rapidfuzz_fuzz is not None:
        try:
            return float(_rapidfuzz_fuzz.partial_ratio(candidate, source))
        except Exception as exc:
            raise CagReviewError("rapidfuzz partial_ratio failed during grounding") from exc
    if not candidate or not source:
        return 0.0
    # Small local fallback for dev environments without rapidfuzz installed.
    from difflib import SequenceMatcher

    if len(candidate) > len(source):
        candidate, source = source, candidate
    best = 0.0
    window = len(candidate)
    for start in range(0, max(len(source) - window + 1, 1)):
        best = max(best, SequenceMatcher(None, candidate, source[start : start + window]).ratio())
        if best >= GROUNDING_FUZZ_MIN / 100:
            break
    return best * 100


def _token_set_ratio(left: str, right: str) -> float:
    if _rapidfuzz_fuzz is not None:
        try:
            return float(_rapidfuzz_fuzz.token_set_ratio(left, right))
        except Exception as exc:
            raise CagReviewError("rapidfuzz token_set_ratio failed during dedup") from exc
    from difflib import SequenceMatcher

    left_tokens = " ".join(sorted(set(_normalize_for_match(left).split())))
    right_tokens = " ".join(sorted(set(_normalize_for_match(right).split())))
    return SequenceMatcher(None, left_tokens, right_tokens).ratio() * 100


def _is_grounded(evidence_text: str, source_text: str) -> bool:
    evidence = _normalize_for_match(evidence_text)
    source = _normalize_for_match(source_text)
    if not evidence:
        return False
    if evidence in source:
        return True
    return _partial_ratio(evidence, source) >= GROUNDING_FUZZ_MIN


def _finding_from_payload(
    finding: dict[str, Any], *, chunk: _Chunk, model_label: str
) -> CagFinding:
    missing = [field for field in REQUIRED_FINDING_FIELDS if not finding.get(field)]
    if missing:
        raise CagReviewError(f"Provider finding missing required fields: {missing}")
    return CagFinding(
        finding_type=finding.get("finding_type") or "rag_review",
        severity=finding.get("severity") or "medium",
        confidence=_coerce_confidence(finding.get("confidence")),
        title=finding["title"],
        explanation=finding["explanation"],
        recommendation=finding["recommendation"],
        evidence_text=finding["evidence_text"],
        page_number=finding.get("page_number"),
        section_title=finding.get("section_title") or chunk.section_title,
        section_index=finding.get("section_index", chunk.section_index),
        normative_source_ref=finding["normative_source_ref"],
        producer_type=finding.get("producer_type") or "controlled_rag",
        producer_id=finding.get("producer_id") or model_label,
        metadata=dict(finding.get("metadata") or {}),
        chunk_index=chunk.index,
    )


def _dedup_findings(findings: list[CagFinding], stats: dict[str, int]) -> list[CagFinding]:
    survivors: list[CagFinding] = []
    for candidate in findings:
        duplicate_index: int | None = None
        for index, existing in enumerate(survivors):
            chunk_distance = abs((candidate.chunk_index or 0) - (existing.chunk_index or 0))
            if chunk_distance > 1:
                continue
            if candidate.finding_type != existing.finding_type:
                continue
            if _token_set_ratio(candidate.evidence_text, existing.evidence_text) < DEDUP_MIN:
                continue
            duplicate_index = index
            break
        if duplicate_index is None:
            survivors.append(candidate)
            continue

        stats["dropped_duplicate"] += 1
        existing = survivors[duplicate_index]
        if candidate.confidence > existing.confidence:
            metadata = dict(candidate.metadata)
            metadata["duplicate_of_pages"] = [
                page for page in [existing.page_number] if page is not None
            ]
            survivors[duplicate_index] = CagFinding(**{**candidate.__dict__, "metadata": metadata})
        else:
            metadata = dict(existing.metadata)
            pages = list(metadata.get("duplicate_of_pages") or [])
            if candidate.page_number is not None:
                pages.append(candidate.page_number)
            metadata["duplicate_of_pages"] = pages
            survivors[duplicate_index] = CagFinding(**{**existing.__dict__, "metadata": metadata})
    return survivors


def _sort_findings(findings: list[CagFinding]) -> list[CagFinding]:
    severity_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    return sorted(
        findings,
        key=lambda finding: (
            severity_rank.get((finding.severity or "medium").lower(), 2),
            finding.page_number if finding.page_number is not None else 10**9,
        ),
    )


def run_cag_review(
    provider: LLMProvider,
    *,
    pages: list[dict[str, Any]],
    sections: list[dict[str, Any]] | None = None,
    corpus_dir: Path = DEFAULT_CORPUS_DIR,
    model_label: str = "claude",
) -> CagReviewResult:
    corpus_text = load_corpus(corpus_dir)
    system_blocks = build_system_blocks(corpus_text)
    chunks = _plan_chunks(pages, sections or [])
    stats = {
        "chunks": 0,
        "dropped_low_confidence": 0,
        "dropped_ungrounded": 0,
        "dropped_duplicate": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
    }
    accepted: list[CagFinding] = []

    for chunk in chunks:
        completion = provider.complete(system_blocks=system_blocks, user_text=chunk.text)
        stats["chunks"] += 1
        stats["cache_read_tokens"] += completion.cache_read_tokens or 0
        stats["cache_write_tokens"] += completion.cache_write_tokens or 0
        payload = _parse_response(completion.text)
        for raw_finding in payload["findings"]:
            if not isinstance(raw_finding, dict):
                raise CagReviewError("Provider finding entries must be objects")
            candidate = _finding_from_payload(raw_finding, chunk=chunk, model_label=model_label)
            if candidate.confidence < MIN_LLM_CONFIDENCE:
                stats["dropped_low_confidence"] += 1
                continue
            if not _is_grounded(candidate.evidence_text, chunk.source_text):
                stats["dropped_ungrounded"] += 1
                continue
            accepted.append(candidate)

    deduped = _dedup_findings(accepted, stats)
    return CagReviewResult(findings=_sort_findings(deduped), stats=stats)


__all__ = [
    "CagFinding",
    "CagReviewError",
    "CagReviewResult",
    "CONTEXT_TAIL_CHARS",
    "DEDUP_MIN",
    "GROUNDING_FUZZ_MIN",
    "MAX_CHUNK_CHARS",
    "MAX_CHUNK_PAGES",
    "MIN_LLM_CONFIDENCE",
    "build_system_blocks",
    "load_corpus",
    "run_cag_review",
]
