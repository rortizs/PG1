import json
import unittest
from pathlib import Path


class FakeLLMProvider:
    """Test double implementing the `LLMProvider` protocol without any network call."""

    def __init__(self, response_text: str | None = None, *, error: Exception | None = None):
        self._response_text = response_text
        self._error = error
        self.received_prompts: list[str] = []

    def generate(self, prompt: str, *, max_tokens: int = 1024) -> str:
        self.received_prompts.append(prompt)
        if self._error is not None:
            raise self._error
        return self._response_text


class CagReviewTest(unittest.TestCase):
    def _corpus_dir(self) -> Path:
        from app.cag_review import DEFAULT_CORPUS_DIR

        return DEFAULT_CORPUS_DIR

    def test_default_corpus_dir_resolves_to_real_academic_rules_files(self):
        corpus_dir = self._corpus_dir()
        self.assertTrue(corpus_dir.is_dir(), f"expected {corpus_dir} to exist")
        txt_files = sorted(corpus_dir.glob("*.txt"))
        self.assertEqual(len(txt_files), 4)

    def test_grounded_excerpt_produces_exactly_one_finding_with_evidence(self):
        from app.cag_review import run_cag_review

        provider = FakeLLMProvider(
            response_text=json.dumps(
                {
                    "finding": {
                        "title": "Missing APA citation",
                        "explanation": "The excerpt paraphrases a source without a citation.",
                        "recommendation": "Add an APA-style in-text citation.",
                        "evidence_text": "Studies show thesis quality improves with review.",
                        "page_number": 3,
                        "section_title": None,
                        "normative_source_ref": "lineamientos_ingenieria_sistemas.txt",
                        "severity": "medium",
                        "confidence": 0.8,
                    }
                }
            )
        )

        finding = run_cag_review(provider, "Studies show thesis quality improves with review.")

        self.assertIsNotNone(finding)
        self.assertEqual(finding.finding_type, "rag_review")
        self.assertEqual(finding.producer_type, "controlled_rag")
        self.assertEqual(finding.evidence_text, "Studies show thesis quality improves with review.")
        self.assertEqual(finding.page_number, 3)
        self.assertEqual(finding.normative_source_ref, "lineamientos_ingenieria_sistemas.txt")
        # The corpus + excerpt must both be present in the single prompt sent.
        self.assertEqual(len(provider.received_prompts), 1)
        prompt = provider.received_prompts[0]
        self.assertIn("Studies show thesis quality improves with review.", prompt)
        self.assertIn("NORMATIVE CORPUS", prompt)

    def test_ungrounded_excerpt_yields_no_finding(self):
        from app.cag_review import run_cag_review

        provider = FakeLLMProvider(response_text=json.dumps({"finding": None}))

        finding = run_cag_review(provider, "A perfectly compliant, unremarkable sentence.")

        self.assertIsNone(finding)

    def test_malformed_json_from_provider_raises_explicit_error_never_fabricates(self):
        from app.cag_review import CagReviewError, run_cag_review

        provider = FakeLLMProvider(response_text="not valid json at all")

        with self.assertRaises(CagReviewError):
            run_cag_review(provider, "Some excerpt.")

    def test_finding_missing_required_fields_raises_explicit_error(self):
        from app.cag_review import CagReviewError, run_cag_review

        provider = FakeLLMProvider(
            response_text=json.dumps({"finding": {"title": "Incomplete finding"}})
        )

        with self.assertRaises(CagReviewError):
            run_cag_review(provider, "Some excerpt.")

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
                run_cag_review(provider, "Some excerpt.")
        finally:
            if previous is not None:
                os.environ["ANTHROPIC_API_KEY"] = previous


if __name__ == "__main__":
    unittest.main()
