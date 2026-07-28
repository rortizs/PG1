"""Pure unit tests for `app.main.select_llm_provider` — the worker-side
provider registry/factory added by llm-provider-admin (Work Units 5-6).

No network calls anywhere in this file: DeepSeek/Groq/unknown providers MUST
raise from `.generate()` (never attempt a real request), and Claude selection
is only introspected via its `_resolve_api_key()`/`_model` attributes.
"""
from __future__ import annotations

import unittest


class ProviderFactoryTest(unittest.TestCase):
    def test_claude_is_the_default_when_provider_name_is_omitted(self):
        from app.main import select_llm_provider
        from app.providers.anthropic_provider import AnthropicProvider

        provider = select_llm_provider(None, None, None)

        self.assertIsInstance(provider, AnthropicProvider)

    def test_claude_selection_forwards_explicit_api_key_and_model_id(self):
        from app.main import select_llm_provider
        from app.providers.anthropic_provider import AnthropicProvider

        provider = select_llm_provider("claude", "sk-explicit-key", "claude-explicit-model")

        self.assertIsInstance(provider, AnthropicProvider)
        self.assertEqual(provider._resolve_api_key(), "sk-explicit-key")
        self.assertEqual(provider._model, "claude-explicit-model")

    def test_deepseek_provider_generate_raises_without_any_network_call(self):
        from app.main import select_llm_provider
        from app.providers.llm_provider import ProviderNotImplementedError

        provider = select_llm_provider("deepseek", "sk-deepseek-key", "deepseek-chat")

        with self.assertRaises(ProviderNotImplementedError) as ctx:
            provider.generate("any prompt")
        self.assertIn("deepseek", str(ctx.exception).lower())
        self.assertNotIn("sk-deepseek-key", str(ctx.exception))

    def test_groq_provider_generate_raises_without_any_network_call(self):
        from app.main import select_llm_provider
        from app.providers.llm_provider import ProviderNotImplementedError

        provider = select_llm_provider("groq", "sk-groq-key", "llama-3")

        with self.assertRaises(ProviderNotImplementedError) as ctx:
            provider.generate("any prompt")
        self.assertIn("groq", str(ctx.exception).lower())
        self.assertNotIn("sk-groq-key", str(ctx.exception))

    def test_unknown_provider_name_fails_loudly_instead_of_silently_falling_back(self):
        from app.main import select_llm_provider
        from app.providers.llm_provider import ProviderNotImplementedError

        provider = select_llm_provider("openai", "sk-should-be-rejected", "gpt-4o")

        with self.assertRaises(ProviderNotImplementedError):
            provider.generate("any prompt")


if __name__ == "__main__":
    unittest.main()
