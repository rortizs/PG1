"""Unit tests for the real DeepSeek chat-completions provider.

No network calls are made: tests replace the provider module's `httpx.Client`
with a tiny fake that records request shape and returns controlled responses.
"""
from __future__ import annotations

import os
import unittest


class FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


class FakeHttpClient:
    next_response = FakeResponse(200, {})
    calls: list[dict] = []
    init_kwargs: dict = {}

    def __init__(self, **kwargs):
        type(self).init_kwargs = kwargs

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def post(self, url: str, *, headers: dict, json: dict):
        type(self).calls.append({"url": url, "headers": headers, "json": json})
        return type(self).next_response


class DeepSeekProviderTest(unittest.TestCase):
    def setUp(self):
        self._previous_api_key = os.environ.pop("DEEPSEEK_API_KEY", None)
        self._previous_base_url = os.environ.pop("DEEPSEEK_BASE_URL", None)
        FakeHttpClient.calls = []
        FakeHttpClient.init_kwargs = {}

    def tearDown(self):
        if self._previous_api_key is not None:
            os.environ["DEEPSEEK_API_KEY"] = self._previous_api_key
        else:
            os.environ.pop("DEEPSEEK_API_KEY", None)
        if self._previous_base_url is not None:
            os.environ["DEEPSEEK_BASE_URL"] = self._previous_base_url
        else:
            os.environ.pop("DEEPSEEK_BASE_URL", None)

    def _patch_httpx_client(self, module):
        original = module.httpx.Client
        module.httpx.Client = FakeHttpClient
        return original

    def test_complete_posts_chat_completions_shape_and_maps_response_usage(self):
        from app.providers import deepseek_provider as module
        from app.providers.deepseek_provider import DeepSeekProvider
        from app.providers.llm_provider import CompletionResult, PromptBlock

        os.environ["DEEPSEEK_BASE_URL"] = "https://deepseek.test/api/"
        FakeHttpClient.next_response = FakeResponse(
            200,
            {
                "choices": [{"message": {"content": "triage says suspect"}}],
                "usage": {
                    "prompt_tokens": 123,
                    "completion_tokens": 45,
                    "prompt_cache_hit_tokens": 67,
                    "prompt_cache_miss_tokens": 89,
                },
            },
        )
        original_client = self._patch_httpx_client(module)
        try:
            result = DeepSeekProvider(api_key="explicit-key", model="deepseek-reasoner").complete(
                system_blocks=[
                    PromptBlock("uncached instruction"),
                    PromptBlock("cacheable corpus A", cacheable=True),
                    PromptBlock("cacheable corpus B", cacheable=True),
                ],
                user_text="student chunk",
                max_tokens=321,
            )
        finally:
            module.httpx.Client = original_client

        self.assertIsInstance(result, CompletionResult)
        self.assertEqual(result.text, "triage says suspect")
        self.assertEqual(result.input_tokens, 123)
        self.assertEqual(result.output_tokens, 45)
        self.assertEqual(result.cache_read_tokens, 67)
        self.assertEqual(result.cache_write_tokens, 89)

        self.assertEqual(len(FakeHttpClient.calls), 1)
        call = FakeHttpClient.calls[0]
        self.assertEqual(call["url"], "https://deepseek.test/api/chat/completions")
        self.assertEqual(call["headers"], {"Authorization": "Bearer explicit-key"})
        self.assertEqual(
            call["json"],
            {
                "model": "deepseek-reasoner",
                "messages": [
                    {
                        "role": "system",
                        "content": "cacheable corpus A\n\ncacheable corpus B\n\nuncached instruction",
                    },
                    {"role": "user", "content": "student chunk"},
                ],
                "max_tokens": 321,
                "temperature": 0,
                "stream": False,
            },
        )

    def test_explicit_api_key_wins_over_env_and_default_base_url_is_official_compatible(self):
        from app.providers import deepseek_provider as module
        from app.providers.deepseek_provider import DeepSeekProvider
        from app.providers.llm_provider import PromptBlock

        os.environ["DEEPSEEK_API_KEY"] = "env-key-must-not-be-used"
        FakeHttpClient.next_response = FakeResponse(
            200, {"choices": [{"message": {"content": "ok"}}], "usage": {}}
        )
        original_client = self._patch_httpx_client(module)
        try:
            DeepSeekProvider(api_key="explicit-key").complete(
                system_blocks=[PromptBlock("system")], user_text="chunk"
            )
        finally:
            module.httpx.Client = original_client

        call = FakeHttpClient.calls[0]
        self.assertEqual(call["url"], "https://api.deepseek.com/chat/completions")
        self.assertEqual(call["headers"]["Authorization"], "Bearer explicit-key")

    def test_env_api_key_is_used_when_no_explicit_key_is_supplied(self):
        from app.providers import deepseek_provider as module
        from app.providers.deepseek_provider import DeepSeekProvider
        from app.providers.llm_provider import PromptBlock

        os.environ["DEEPSEEK_API_KEY"] = "env-key"
        FakeHttpClient.next_response = FakeResponse(
            200, {"choices": [{"message": {"content": "ok"}}], "usage": {}}
        )
        original_client = self._patch_httpx_client(module)
        try:
            DeepSeekProvider().complete(system_blocks=[PromptBlock("system")], user_text="chunk")
        finally:
            module.httpx.Client = original_client

        self.assertEqual(FakeHttpClient.calls[0]["headers"]["Authorization"], "Bearer env-key")

    def test_missing_key_raises_config_error_subclass_without_network_call(self):
        from app.providers.deepseek_provider import DeepSeekProvider, DeepSeekProviderConfigError
        from app.providers.llm_provider import LLMProviderError, PromptBlock

        self.assertTrue(issubclass(DeepSeekProviderConfigError, LLMProviderError))
        with self.assertRaises(DeepSeekProviderConfigError) as ctx:
            DeepSeekProvider().complete(system_blocks=[PromptBlock("system")], user_text="chunk")
        self.assertIn("DEEPSEEK_API_KEY", str(ctx.exception))
        self.assertEqual(FakeHttpClient.calls, [])

    def test_upstream_4xx_5xx_raise_sanitized_upstream_error_subclass(self):
        from app.providers import deepseek_provider as module
        from app.providers.deepseek_provider import DeepSeekProvider, DeepSeekProviderUpstreamError
        from app.providers.llm_provider import LLMProviderError, PromptBlock

        self.assertTrue(issubclass(DeepSeekProviderUpstreamError, LLMProviderError))
        FakeHttpClient.next_response = FakeResponse(500, {"error": {"message": "bad upstream"}}, "raw")
        original_client = self._patch_httpx_client(module)
        try:
            with self.assertRaises(DeepSeekProviderUpstreamError) as ctx:
                DeepSeekProvider(api_key="secret-deepseek-key").complete(
                    system_blocks=[PromptBlock("system")], user_text="chunk"
                )
        finally:
            module.httpx.Client = original_client

        self.assertIn("DeepSeek API call failed", str(ctx.exception))
        self.assertIn("500", str(ctx.exception))
        self.assertNotIn("secret-deepseek-key", str(ctx.exception))

    def test_response_without_text_choice_raises_upstream_error(self):
        from app.providers import deepseek_provider as module
        from app.providers.deepseek_provider import DeepSeekProvider, DeepSeekProviderUpstreamError
        from app.providers.llm_provider import PromptBlock

        FakeHttpClient.next_response = FakeResponse(200, {"choices": [], "usage": {}})
        original_client = self._patch_httpx_client(module)
        try:
            with self.assertRaises(DeepSeekProviderUpstreamError):
                DeepSeekProvider(api_key="secret-deepseek-key").complete(
                    system_blocks=[PromptBlock("system")], user_text="chunk"
                )
        finally:
            module.httpx.Client = original_client


if __name__ == "__main__":
    unittest.main()
