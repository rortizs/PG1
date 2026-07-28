"""Real Claude provider, implementing the `LLMProvider` protocol.

The API key is resolved lazily, inside `generate()` — never at import time
or construction time — so this module can be safely imported, and
`AnthropicProvider()` safely constructed, in test processes that have no API
key configured. Only an actual `.generate()` call requires a key.

llm-provider-admin (Work Unit 5): the NestJS API now resolves the DB-active
provider and forwards its decrypted `api_key`/`model_id` on each request.
`AnthropicProvider` accepts an explicit `api_key` at construction time and
prefers it over `ANTHROPIC_API_KEY` (arg-then-env precedence, design
decision #11) — the env var stays as the fallback for local dev/testing and
for any caller that has not been updated to send an explicit key.
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
        api_key: str | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._model = model
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds

    def _resolve_api_key(self) -> str | None:
        """Arg-then-env precedence: an explicit `api_key` (the DB-resolved
        active provider's decrypted key, forwarded by the API) always wins
        over `ANTHROPIC_API_KEY` when both are present."""
        return self._api_key or os.environ.get("ANTHROPIC_API_KEY")

    def generate(self, prompt: str, *, max_tokens: int = 1024) -> str:
        api_key = self._resolve_api_key()
        if not api_key:
            raise AnthropicProviderConfigError(
                "No Anthropic API key available — neither an explicit api_key "
                "nor ANTHROPIC_API_KEY is set — cannot call the real Claude API."
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
