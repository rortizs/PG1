"""Real Claude provider, implementing the `LLMProvider` protocol.

`ANTHROPIC_API_KEY` is read from the environment lazily, inside `generate()`
— never at import time or construction time — so this module can be safely
imported, and `AnthropicProvider()` safely constructed, in test processes
that have no API key configured. Only an actual `.generate()` call requires
the key.
"""
from __future__ import annotations

import os

from .llm_provider import LLMProviderError

DEFAULT_MODEL = "claude-sonnet-4-20250514"
DEFAULT_TIMEOUT_SECONDS = 30.0


class AnthropicProviderConfigError(LLMProviderError):
    """Raised when required Anthropic configuration (the API key) is missing."""


class AnthropicProviderUpstreamError(LLMProviderError):
    """Raised when the Claude API call itself fails or times out."""


class AnthropicProvider:
    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        *,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._model = model
        self._timeout_seconds = timeout_seconds

    def generate(self, prompt: str, *, max_tokens: int = 1024) -> str:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise AnthropicProviderConfigError(
                "ANTHROPIC_API_KEY is not set — cannot call the real Claude API."
            )

        # Imported lazily so the `anthropic` package only needs to be
        # importable, not configured, for the rest of the module to load.
        from anthropic import APIError, Anthropic

        client = Anthropic(api_key=api_key, timeout=self._timeout_seconds)
        try:
            response = client.messages.create(
                model=self._model,
                max_tokens=max_tokens,
                messages=[{"role": "user", "content": prompt}],
            )
        except APIError as exc:
            raise AnthropicProviderUpstreamError(
                f"Claude API call failed: {exc}"
            ) from exc

        text_blocks = [
            block.text for block in response.content if getattr(block, "type", None) == "text"
        ]
        if not text_blocks:
            raise AnthropicProviderUpstreamError(
                "Claude API response contained no text content"
            )
        return "".join(text_blocks)
