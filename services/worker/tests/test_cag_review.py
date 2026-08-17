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

    def test_retrieved_context_prompt_uses_only_retrieved_segments_as_real_rag_context(self):
        from app.cag_review import run_cag_review

        provider = FakeLLMProvider(response_text=json.dumps({"finding": None}))

        finding = run_cag_review(
            provider,
            "The thesis omits APA citation details.",
            retrieved_context=[
                {
                    "source_ref": "guide.txt",
                    "segment_text": "APA citation rules require references.",
                    "similarity_score": 0.03,
                }
            ],
        )

        self.assertIsNone(finding)
        prompt = provider.received_prompts[0]
        self.assertIn("RETRIEVED NORMATIVE CONTEXT", prompt)
        self.assertIn("APA citation rules require references.", prompt)
        self.assertNotIn("NORMATIVE CORPUS", prompt)

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

    def test_invalid_confidence_raises_cag_review_error_never_raw_value_error(self):
        from app.cag_review import CagReviewError, run_cag_review

        provider = FakeLLMProvider(
            response_text=json.dumps(
                {
                    "finding": {
                        "title": "Invalid confidence",
                        "explanation": "The provider returned an invalid confidence.",
                        "recommendation": "Return a numeric confidence.",
                        "evidence_text": "Some excerpt.",
                        "normative_source_ref": "guide.txt",
                        "confidence": "not-a-number",
                    }
                }
            )
        )

        with self.assertRaises(CagReviewError):
            run_cag_review(provider, "Some excerpt.")

    def test_missing_anthropic_api_key_raises_explicit_config_error(self):
        """Both the request payload AND the env var are absent — still fails
        explicitly. Reworked for llm-provider-admin: `AnthropicProvider()` no
        longer implicitly means "read only the env var" — it means "no
        explicit key was supplied", which still falls back to the env var
        when present and still fails when neither is present."""
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

    def test_explicit_api_key_and_model_take_precedence_over_env_when_both_present(self):
        """llm-provider-admin: the DB-resolved active provider's api_key/model_id
        (forwarded from the API as explicit constructor args) MUST win over
        whatever ANTHROPIC_API_KEY happens to be set in the worker's own
        environment (e.g. left over from local dev) — never silently prefer
        the env var when a payload value was actually supplied."""
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
        """Rollback / local-dev requirement (design decision #11): the
        ANTHROPIC_API_KEY env fallback MUST keep working when the request
        carries no explicit api_key at all."""
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
