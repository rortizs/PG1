"""Pure unit tests for `app.main.select_llm_provider` and provider protocol wiring.

No real network calls occur in this file: DeepSeek and Claude selection are
only introspected through their local configuration attributes, while Groq and
unknown providers still raise from `.complete()` without attempting a request.
"""
from __future__ import annotations

import os
import sys
import types
import unittest
from typing import cast
from types import SimpleNamespace


class ProviderFactoryTest(unittest.TestCase):
    def test_provider_protocol_exposes_complete_result_types_and_no_generate(self):
        from app.providers.anthropic_provider import AnthropicProvider
        from app.providers.llm_provider import CompletionResult, LLMProvider, PromptBlock
        from app.providers.unimplemented_provider import UnimplementedProvider

        self.assertEqual(PromptBlock("rules").text, "rules")
        self.assertFalse(PromptBlock("rules").cacheable)
        self.assertTrue(PromptBlock("rules", cacheable=True).cacheable)

        result = CompletionResult(
            text="ok",
            input_tokens=10,
            output_tokens=3,
            cache_read_tokens=7,
            cache_write_tokens=11,
        )
        self.assertEqual(result.text, "ok")
        self.assertEqual(result.cache_read_tokens, 7)
        self.assertEqual(result.cache_write_tokens, 11)

        self.assertTrue(hasattr(LLMProvider, "complete"))
        self.assertFalse(hasattr(LLMProvider, "generate"))
        self.assertFalse(hasattr(AnthropicProvider(api_key="sk-test"), "generate"))
        self.assertFalse(hasattr(UnimplementedProvider("groq"), "generate"))

    def test_claude_is_the_default_when_provider_name_is_omitted(self):
        from app.main import select_llm_provider
        from app.providers.anthropic_provider import AnthropicProvider

        provider = select_llm_provider(None, None, None)

        self.assertIsInstance(provider, AnthropicProvider)

    def test_claude_selection_forwards_explicit_api_key_and_model_id(self):
        from app.main import select_llm_provider
        from app.providers.anthropic_provider import AnthropicProvider

        provider = cast(
            AnthropicProvider,
            select_llm_provider("claude", "sk-explicit-key", "claude-explicit-model"),
        )

        self.assertIsInstance(provider, AnthropicProvider)
        self.assertEqual(provider._resolve_api_key(), "sk-explicit-key")
        self.assertEqual(provider._model, "claude-explicit-model")

    def test_deepseek_selection_returns_real_provider_with_explicit_key_and_model(self):
        from app.main import select_llm_provider
        from app.providers.deepseek_provider import DeepSeekProvider

        provider = cast(
            DeepSeekProvider,
            select_llm_provider("deepseek", "sk-deepseek-key", "deepseek-chat"),
        )

        self.assertIsInstance(provider, DeepSeekProvider)
        self.assertEqual(provider._resolve_api_key(), "sk-deepseek-key")
        self.assertEqual(provider._model, "deepseek-chat")

    def test_groq_provider_complete_raises_without_any_network_call(self):
        from app.main import select_llm_provider
        from app.providers.llm_provider import ProviderNotImplementedError, PromptBlock

        provider = select_llm_provider("groq", "sk-groq-key", "llama-3")

        with self.assertRaises(ProviderNotImplementedError) as ctx:
            provider.complete(system_blocks=[PromptBlock("rules")], user_text="any prompt")
        self.assertIn("groq", str(ctx.exception).lower())
        self.assertNotIn("sk-groq-key", str(ctx.exception))

    def test_unknown_provider_name_fails_loudly_instead_of_silently_falling_back(self):
        from app.main import select_llm_provider
        from app.providers.llm_provider import ProviderNotImplementedError, PromptBlock

        provider = select_llm_provider("openai", "sk-should-be-rejected", "gpt-4o")

        with self.assertRaises(ProviderNotImplementedError):
            provider.complete(system_blocks=[PromptBlock("rules")], user_text="any prompt")

    def test_anthropic_complete_maps_cacheable_system_blocks_and_usage_tokens(self):
        from app.providers.anthropic_provider import AnthropicProvider
        from app.providers.llm_provider import CompletionResult, PromptBlock

        fake_anthropic = self._install_fake_anthropic_module()
        previous_ttl = os.environ.pop("ANTHROPIC_CACHE_TTL", None)
        try:
            provider = AnthropicProvider(model="claude-test", api_key="sk-test")

            result = provider.complete(
                system_blocks=[
                    PromptBlock("stable corpus", cacheable=True),
                    PromptBlock("uncached instruction"),
                ],
                user_text="student excerpt",
                max_tokens=77,
            )
        finally:
            self._restore_anthropic_module(fake_anthropic)
            if previous_ttl is not None:
                os.environ["ANTHROPIC_CACHE_TTL"] = previous_ttl

        self.assertIsInstance(result, CompletionResult)
        self.assertEqual(result.text, "hello world")
        self.assertEqual(result.input_tokens, 101)
        self.assertEqual(result.output_tokens, 17)
        self.assertEqual(result.cache_read_tokens, 23)
        self.assertEqual(result.cache_write_tokens, 29)

        client = fake_anthropic.created_clients[0]
        self.assertNotIn("default_headers", client.init_kwargs)
        call = client.messages.calls[0]
        self.assertEqual(call["model"], "claude-test")
        self.assertEqual(call["max_tokens"], 77)
        self.assertEqual(
            call["messages"], [{"role": "user", "content": "student excerpt"}]
        )
        self.assertEqual(
            call["system"],
            [
                {
                    "type": "text",
                    "text": "stable corpus",
                    "cache_control": {"type": "ephemeral"},
                },
                {"type": "text", "text": "uncached instruction"},
            ],
        )

    def test_anthropic_one_hour_cache_ttl_adds_beta_header_and_ttl(self):
        from app.providers.anthropic_provider import AnthropicProvider
        from app.providers.llm_provider import PromptBlock

        fake_anthropic = self._install_fake_anthropic_module()
        previous_ttl = os.environ.get("ANTHROPIC_CACHE_TTL")
        os.environ["ANTHROPIC_CACHE_TTL"] = "1h"
        try:
            provider = AnthropicProvider(model="claude-test", api_key="sk-test")

            provider.complete(
                system_blocks=[PromptBlock("stable corpus", cacheable=True)],
                user_text="student excerpt",
            )
        finally:
            self._restore_anthropic_module(fake_anthropic)
            if previous_ttl is not None:
                os.environ["ANTHROPIC_CACHE_TTL"] = previous_ttl
            else:
                os.environ.pop("ANTHROPIC_CACHE_TTL", None)

        client = fake_anthropic.created_clients[0]
        self.assertEqual(
            client.init_kwargs["default_headers"],
            {"anthropic-beta": "extended-cache-ttl-2025-04-11"},
        )
        call = client.messages.calls[0]
        self.assertEqual(
            call["system"],
            [
                {
                    "type": "text",
                    "text": "stable corpus",
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},
                }
            ],
        )

    def _install_fake_anthropic_module(self):
        original = sys.modules.get("anthropic")
        sentinel = object()
        if original is None:
            original = sentinel

        response = SimpleNamespace(
            content=[
                SimpleNamespace(type="text", text="hello"),
                SimpleNamespace(type="text", text=" world"),
            ],
            usage=SimpleNamespace(
                input_tokens=101,
                output_tokens=17,
                cache_read_input_tokens=23,
                cache_creation_input_tokens=29,
            ),
        )

        fake_module = types.ModuleType("anthropic")
        created_clients = []
        setattr(fake_module, "APIError", Exception)
        setattr(fake_module, "created_clients", created_clients)

        class FakeMessages:
            def __init__(self):
                self.calls = []

            def create(self, **kwargs):
                self.calls.append(kwargs)
                return response

        class FakeAnthropic:
            def __init__(self, **kwargs):
                self.init_kwargs = kwargs
                self.messages = FakeMessages()
                created_clients.append(self)

        setattr(fake_module, "Anthropic", FakeAnthropic)
        setattr(fake_module, "_original", original)
        setattr(fake_module, "_sentinel", sentinel)
        sys.modules["anthropic"] = fake_module
        return fake_module

    def _restore_anthropic_module(self, fake_module):
        original = getattr(fake_module, "_original")
        sentinel = getattr(fake_module, "_sentinel")
        if original is sentinel:
            sys.modules.pop("anthropic", None)
        else:
            sys.modules["anthropic"] = original


if __name__ == "__main__":
    unittest.main()
