import json
import unittest
from pathlib import Path


class FakeLLMProvider:
    """Test double implementing the `LLMProvider` protocol without any network call."""

    def __init__(self, responses: list[str] | None = None, *, error: Exception | None = None):
        self._responses = list(responses or [])
        self._error = error
        self.received_calls: list[dict] = []

    def complete(self, *, system_blocks, user_text: str, max_tokens: int = 2048):
        from app.providers.llm_provider import CompletionResult

        self.received_calls.append(
            {"system_blocks": system_blocks, "user_text": user_text, "max_tokens": max_tokens}
        )
        if self._error is not None:
            raise self._error
        if not self._responses:
            raise AssertionError("FakeLLMProvider received more calls than configured responses")
        response_text = self._responses.pop(0)
        return CompletionResult(
            text=response_text,
            cache_read_tokens=10 if len(self.received_calls) > 1 else 0,
            cache_write_tokens=25 if len(self.received_calls) == 1 else 0,
        )


def finding_payload(
    *,
    title: str,
    evidence_text: str,
    page_number: int,
    section_index: int | None,
    confidence: float = 0.9,
    severity: str = "medium",
):
    return {
        "title": title,
        "explanation": f"Explanation for {title}.",
        "recommendation": f"Recommendation for {title}.",
        "evidence_text": evidence_text,
        "page_number": page_number,
        "section_index": section_index,
        "normative_source_ref": "lineamientos_ingenieria_sistemas.txt",
        "severity": severity,
        "confidence": confidence,
    }


class CagReviewTest(unittest.TestCase):
    def _corpus_dir(self) -> Path:
        from app.cag_review import DEFAULT_CORPUS_DIR

        return DEFAULT_CORPUS_DIR

    def _pages(self, count: int = 4) -> list[dict]:
        return [
            {
                "page_number": page,
                "section_title": f"Section {((page - 1) // 2) + 1}",
                "text": f"Page {page} text. Grounded issue {page} appears here.",
            }
            for page in range(1, count + 1)
        ]

    def _sections(self) -> list[dict]:
        return [
            {
                "index": 0,
                "title": "Section 1",
                "section_type": "chapter",
                "start_page_number": 1,
                "end_page_number": 2,
                "is_location_uncertain": False,
            },
            {
                "index": 1,
                "title": "Section 2",
                "section_type": "chapter",
                "start_page_number": 3,
                "end_page_number": 4,
                "is_location_uncertain": False,
            },
        ]

    def test_default_corpus_dir_resolves_to_real_academic_rules_files(self):
        corpus_dir = self._corpus_dir()
        self.assertTrue(corpus_dir.is_dir(), f"expected {corpus_dir} to exist")
        txt_files = sorted(corpus_dir.glob("*.txt"))
        self.assertEqual(len(txt_files), 4)

    def test_sections_plan_one_provider_call_per_section_and_cacheable_corpus(self):
        from app.cag_review import run_cag_review

        pages = [
            {"page_number": 1, "section_title": "Section 1", "text": "APA citation is missing here."},
            {"page_number": 2, "section_title": "Section 1", "text": "Supporting text."},
            {"page_number": 3, "section_title": "Section 2", "text": "Methodology wording is ambiguous here."},
            {"page_number": 4, "section_title": "Section 2", "text": "Supporting text."},
        ]
        provider = FakeLLMProvider(
            responses=[
                json.dumps(
                    {
                        "findings": [
                            finding_payload(
                                title="Issue in first section",
                                evidence_text="APA citation is missing here.",
                                page_number=1,
                                section_index=0,
                                severity="medium",
                            )
                        ]
                    }
                ),
                json.dumps(
                    {
                        "findings": [
                            finding_payload(
                                title="Issue in second section",
                                evidence_text="Methodology wording is ambiguous here.",
                                page_number=3,
                                section_index=1,
                                severity="high",
                            )
                        ]
                    }
                ),
            ]
        )

        result = run_cag_review(provider, pages=pages, sections=self._sections())

        self.assertEqual(len(provider.received_calls), 2)
        self.assertEqual([finding.title for finding in result.findings], [
            "Issue in second section",
            "Issue in first section",
        ])
        self.assertEqual(result.stats["chunks"], 2)
        self.assertEqual(result.stats["cache_read_tokens"], 10)
        self.assertEqual(result.stats["cache_write_tokens"], 25)
        for call in provider.received_calls:
            corpus_blocks = [b for b in call["system_blocks"] if "NORMATIVE CORPUS" in b.text]
            self.assertEqual(len(corpus_blocks), 1)
            self.assertTrue(corpus_blocks[0].cacheable)

    def test_zero_sections_falls_back_to_eight_page_windows_with_context_tail(self):
        from app.cag_review import run_cag_review

        pages = self._pages(9)
        provider = FakeLLMProvider(
            responses=[
                json.dumps({"findings": []}),
                json.dumps(
                    {
                        "findings": [
                            finding_payload(
                                title="Ninth page issue",
                                evidence_text="Grounded issue 9 appears here.",
                                page_number=9,
                                section_index=None,
                            )
                        ]
                    }
                ),
            ]
        )

        result = run_cag_review(provider, pages=pages, sections=[])

        self.assertEqual(len(provider.received_calls), 2)
        self.assertIn("Page 1 text", provider.received_calls[0]["user_text"])
        self.assertIn("Page 8 text", provider.received_calls[0]["user_text"])
        self.assertNotIn("Page 9 text", provider.received_calls[0]["user_text"])
        self.assertIn("CONTEXT ONLY — do not report findings from this block", provider.received_calls[1]["user_text"])
        self.assertIn("Page 9 text", provider.received_calls[1]["user_text"])
        self.assertEqual(len(result.findings), 1)
        self.assertIsNone(result.findings[0].section_index)

    def test_triage_not_suspect_skips_judgment_for_that_chunk(self):
        from app.cag_review import run_cag_review

        judgment_provider = FakeLLMProvider()
        triage_provider = FakeLLMProvider(responses=[json.dumps({"suspect": False})])

        result = run_cag_review(
            judgment_provider,
            triage_provider=triage_provider,
            pages=self._pages(1),
            sections=[],
        )

        self.assertEqual(judgment_provider.received_calls, [])
        self.assertEqual(len(triage_provider.received_calls), 1)
        self.assertEqual(result.findings, [])
        self.assertEqual(result.stats["chunks"], 1)
        self.assertEqual(result.stats["triage_skipped"], 1)
        self.assertEqual(result.stats["triage_errors"], 0)

    def test_triage_suspect_runs_judgment_for_that_chunk(self):
        from app.cag_review import run_cag_review

        triage_provider = FakeLLMProvider(responses=[json.dumps({"suspect": True})])
        judgment_provider = FakeLLMProvider(
            responses=[
                json.dumps(
                    {
                        "findings": [
                            finding_payload(
                                title="Judged issue",
                                evidence_text="Grounded issue 1 appears here.",
                                page_number=1,
                                section_index=None,
                            )
                        ]
                    }
                )
            ]
        )

        result = run_cag_review(
            judgment_provider,
            triage_provider=triage_provider,
            pages=self._pages(1),
            sections=[],
        )

        self.assertEqual(len(triage_provider.received_calls), 1)
        self.assertEqual(len(judgment_provider.received_calls), 1)
        self.assertEqual([finding.title for finding in result.findings], ["Judged issue"])
        self.assertEqual(result.stats["triage_skipped"], 0)
        self.assertEqual(result.stats["triage_errors"], 0)

    def test_triage_error_fails_open_into_judgment_without_leaking_triage_key(self):
        from app.cag_review import run_cag_review

        secret = "sk-triage-secret-must-not-leak"
        triage_provider = FakeLLMProvider(error=RuntimeError(f"upstream failed {secret}"))
        judgment_provider = FakeLLMProvider(
            responses=[
                json.dumps(
                    {
                        "findings": [
                            finding_payload(
                                title="Judged after triage failure",
                                evidence_text="Grounded issue 1 appears here.",
                                page_number=1,
                                section_index=None,
                            )
                        ]
                    }
                )
            ]
        )

        result = run_cag_review(
            judgment_provider,
            triage_provider=triage_provider,
            pages=self._pages(1),
            sections=[],
        )

        self.assertEqual(len(judgment_provider.received_calls), 1)
        self.assertEqual(result.stats["triage_errors"], 1)
        self.assertNotIn(secret, json.dumps(result.stats))
        self.assertNotIn(secret, repr(result.findings))
        self.assertEqual([finding.title for finding in result.findings], ["Judged after triage failure"])

    def test_confidence_grounding_and_dedup_filters_drop_candidates_without_merging(self):
        from app.cag_review import run_cag_review

        pages = self._pages()
        provider = FakeLLMProvider(
            responses=[
                json.dumps(
                    {
                        "findings": [
                            finding_payload(
                                title="Low confidence",
                                evidence_text="Grounded issue 1 appears here.",
                                page_number=1,
                                section_index=0,
                                confidence=0.74,
                            ),
                            finding_payload(
                                title="Ungrounded",
                                evidence_text="This text does not occur in the chunk.",
                                page_number=1,
                                section_index=0,
                                confidence=0.95,
                            ),
                            finding_payload(
                                title="Duplicate lower confidence",
                                evidence_text="Grounded issue 2 appears here.",
                                page_number=2,
                                section_index=0,
                                confidence=0.8,
                            ),
                        ]
                    }
                ),
                json.dumps(
                    {
                        "findings": [
                            finding_payload(
                                title="Duplicate higher confidence",
                                evidence_text="Grounded issue 3 appears here.",
                                page_number=3,
                                section_index=1,
                                confidence=0.95,
                            )
                        ]
                    }
                ),
            ]
        )

        result = run_cag_review(provider, pages=pages, sections=self._sections())

        self.assertEqual([finding.title for finding in result.findings], ["Duplicate higher confidence"])
        self.assertEqual(result.stats["dropped_low_confidence"], 1)
        self.assertEqual(result.stats["dropped_ungrounded"], 1)
        self.assertEqual(result.stats["dropped_duplicate"], 1)
        self.assertEqual(result.findings[0].metadata.get("duplicate_of_pages"), [2])

    def test_all_grounded_above_threshold_findings_are_returned_sorted_with_no_cap(self):
        from app.cag_review import run_cag_review

        phrases = [
            "Alpha citation gap appears here.",
            "Beta methodology gap appears here.",
            "Gamma objective gap appears here.",
            "Delta bibliography gap appears here.",
            "Epsilon reference gap appears here.",
            "Zeta annex gap appears here.",
            "Eta context sentence appears here.",
            "Theta context sentence appears here.",
            "Iota critical gap appears here.",
            "Kappa high gap appears here.",
        ]
        pages = [
            {"page_number": index + 1, "section_title": None, "text": phrase}
            for index, phrase in enumerate(phrases)
        ]
        first_chunk_findings = [
            finding_payload(title=f"Medium {i}", evidence_text=phrases[i - 1], page_number=i, section_index=None, severity="medium")
            for i in range(1, 7)
        ]
        second_chunk_findings = [
            finding_payload(title="Critical later", evidence_text=phrases[8], page_number=9, section_index=None, severity="critical"),
            finding_payload(title="High later", evidence_text=phrases[9], page_number=10, section_index=None, severity="high"),
        ]
        provider = FakeLLMProvider(
            responses=[
                json.dumps({"findings": first_chunk_findings}),
                json.dumps({"findings": second_chunk_findings}),
            ]
        )

        result = run_cag_review(provider, pages=pages, sections=[])

        self.assertEqual(len(result.findings), 8)
        self.assertEqual([finding.title for finding in result.findings[:2]], ["Critical later", "High later"])
        medium_pages = [finding.page_number for finding in result.findings if finding.severity == "medium"]
        self.assertEqual(medium_pages, [1, 2, 3, 4, 5, 6])

    def test_malformed_json_from_provider_raises_explicit_error_never_fabricates(self):
        from app.cag_review import CagReviewError, run_cag_review

        provider = FakeLLMProvider(responses=["not valid json at all"])

        with self.assertRaises(CagReviewError):
            run_cag_review(provider, pages=self._pages(1), sections=[])

    def test_finding_missing_required_fields_raises_explicit_error(self):
        from app.cag_review import CagReviewError, run_cag_review

        provider = FakeLLMProvider(responses=[json.dumps({"findings": [{"title": "Incomplete"}]})])

        with self.assertRaises(CagReviewError):
            run_cag_review(provider, pages=self._pages(1), sections=[])

    def test_invalid_confidence_raises_cag_review_error_never_raw_value_error(self):
        from app.cag_review import CagReviewError, run_cag_review

        bad = finding_payload(
            title="Invalid confidence",
            evidence_text="Grounded issue 1 appears here.",
            page_number=1,
            section_index=None,
        )
        bad["confidence"] = "not-a-number"
        provider = FakeLLMProvider(responses=[json.dumps({"findings": [bad]})])

        with self.assertRaises(CagReviewError):
            run_cag_review(provider, pages=self._pages(1), sections=[])

    def test_missing_anthropic_api_key_raises_explicit_config_error(self):
        import os

        from app.cag_review import run_cag_review
        from app.providers.anthropic_provider import (
            AnthropicProvider,
            AnthropicProviderConfigError,
        )

        previous = os.environ.pop("ANTHROPIC_API_KEY", None)
        try:
            provider = AnthropicProvider()
            with self.assertRaises(AnthropicProviderConfigError):
                run_cag_review(provider, pages=self._pages(1), sections=[])
        finally:
            if previous is not None:
                os.environ["ANTHROPIC_API_KEY"] = previous

    def test_explicit_api_key_and_model_take_precedence_over_env_when_both_present(self):
        import os

        from app.providers.anthropic_provider import AnthropicProvider

        previous = os.environ.get("ANTHROPIC_API_KEY")
        os.environ["ANTHROPIC_API_KEY"] = "env-key-must-not-be-used"
        try:
            provider = AnthropicProvider(
                model="claude-explicit-model", api_key="explicit-key-from-request"
            )
            self.assertEqual(provider._resolve_api_key(), "explicit-key-from-request")
            self.assertEqual(provider._model, "claude-explicit-model")
        finally:
            if previous is not None:
                os.environ["ANTHROPIC_API_KEY"] = previous
            else:
                os.environ.pop("ANTHROPIC_API_KEY", None)

    def test_env_api_key_still_used_when_no_explicit_key_supplied(self):
        import os

        from app.providers.anthropic_provider import AnthropicProvider

        previous = os.environ.get("ANTHROPIC_API_KEY")
        os.environ["ANTHROPIC_API_KEY"] = "env-key-should-be-used"
        try:
            provider = AnthropicProvider()
            self.assertEqual(provider._resolve_api_key(), "env-key-should-be-used")
        finally:
            if previous is not None:
                os.environ["ANTHROPIC_API_KEY"] = previous
            else:
                os.environ.pop("ANTHROPIC_API_KEY", None)


if __name__ == "__main__":
    unittest.main()
