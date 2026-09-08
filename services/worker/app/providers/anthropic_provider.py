"""Real Claude provider, implementing the `LLMProvider` protocol.

The API key is resolved lazily, inside `complete()` — never at import time
or construction time — so this module can be safely imported, and
`AnthropicProvider()` safely constructed, in test processes that have no API
key configured. Only an actual `.complete()` call requires a key.

llm-provider-admin (Work Unit 5): the NestJS API now resolves the DB-active
provider and forwards its decrypted `api_key`/`model_id` on each request.
`AnthropicProvider` accepts an explicit `api_key` at construction time and
prefers it over `ANTHROPIC_API_KEY` (arg-then-env precedence, design
decision #11) — the env var stays as the fallback for local dev/testing and
for any caller that has not been updated to send an explicit key.
"""
from __future__ import annotations

import os
from typing import Any, cast

from .llm_provider import CompletionResult, LLMProviderError, PromptBlock

DEFAULT_MODEL = "claude-sonnet-4-20250514"
DEFAULT_TIMEOUT_SECONDS = 30.0
ANTHROPIC_CACHE_TTL_ENV = "ANTHROPIC_CACHE_TTL"
DEFAULT_CACHE_TTL = "5m"
EXTENDED_CACHE_TTL = "1h"
EXTENDED_CACHE_TTL_BETA_HEADER = "extended-cache-ttl-2025-04-11"


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

    def complete(
        self,
        *,
        system_blocks: list[PromptBlock],
        user_text: str,
        max_tokens: int = 2048,
    ) -> CompletionResult:
        api_key = self._resolve_api_key()
        if not api_key:
            raise AnthropicProviderConfigError(
                "No Anthropic API key available — neither an explicit api_key "
                "nor ANTHROPIC_API_KEY is set — cannot call the real Claude API."
            )

        # Imported lazily so the `anthropic` package only needs to be
        # importable, not configured, for the rest of the module to load.
        from anthropic import APIError, Anthropic

        client_kwargs: dict[str, Any] = {"api_key": api_key, "timeout": self._timeout_seconds}
        cache_ttl = os.environ.get(ANTHROPIC_CACHE_TTL_ENV, DEFAULT_CACHE_TTL)
        if cache_ttl == EXTENDED_CACHE_TTL:
            client_kwargs["default_headers"] = {
                "anthropic-beta": EXTENDED_CACHE_TTL_BETA_HEADER
            }

        client = Anthropic(**client_kwargs)
        system_payload = [_to_anthropic_system_block(block, cache_ttl) for block in system_blocks]
        try:
            response = client.messages.create(
                model=self._model,
                max_tokens=max_tokens,
                system=cast(Any, system_payload),
                messages=[{"role": "user", "content": user_text}],
            )
        except APIError as exc:
            raise AnthropicProviderUpstreamError(
                f"Claude API call failed: {exc}"
            ) from exc

        text_blocks = []
        for block in response.content:
            if getattr(block, "type", None) != "text":
                continue
            text = getattr(block, "text", None)
            if isinstance(text, str):
                text_blocks.append(text)
        if not text_blocks:
            raise AnthropicProviderUpstreamError(
                "Claude API response contained no text content"
            )

        usage = getattr(response, "usage", None)
        return CompletionResult(
            text="".join(text_blocks),
            input_tokens=getattr(usage, "input_tokens", None),
            output_tokens=getattr(usage, "output_tokens", None),
            cache_read_tokens=getattr(usage, "cache_read_input_tokens", None),
            cache_write_tokens=getattr(usage, "cache_creation_input_tokens", None),
        )


def _to_anthropic_system_block(block: PromptBlock, cache_ttl: str) -> dict[str, Any]:
    payload: dict[str, Any] = {"type": "text", "text": block.text}
    if block.cacheable:
        cache_control = {"type": "ephemeral"}
        if cache_ttl == EXTENDED_CACHE_TTL:
            cache_control["ttl"] = EXTENDED_CACHE_TTL
        payload["cache_control"] = cache_control
    return payload
