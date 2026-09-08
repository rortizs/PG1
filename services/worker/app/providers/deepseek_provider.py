"""Real DeepSeek provider using the OpenAI-compatible chat completions API.

The API key is resolved lazily inside `complete()`, mirroring the Anthropic
provider's failure surface: imports and construction are safe without local
credentials, while actual use fails loudly with typed provider errors.
"""
from __future__ import annotations

import os
from typing import Any

import httpx

from .llm_provider import CompletionResult, LLMProviderError, PromptBlock

DEFAULT_MODEL = "deepseek-chat"
DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_TIMEOUT_SECONDS = 30.0
DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY"
DEEPSEEK_BASE_URL_ENV = "DEEPSEEK_BASE_URL"


class DeepSeekProviderConfigError(LLMProviderError):
    """Raised when required DeepSeek configuration is missing."""


class DeepSeekProviderUpstreamError(LLMProviderError):
    """Raised when the DeepSeek API call or response is unusable."""


class DeepSeekProvider:
    def __init__(
        self,
        model: str | None = DEFAULT_MODEL,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._model = model or DEFAULT_MODEL
        self._api_key = api_key
        self._base_url = base_url
        self._timeout_seconds = timeout_seconds

    def _resolve_api_key(self) -> str | None:
        return self._api_key or os.environ.get(DEEPSEEK_API_KEY_ENV)

    def _resolve_base_url(self) -> str:
        return (self._base_url or os.environ.get(DEEPSEEK_BASE_URL_ENV) or DEFAULT_BASE_URL).rstrip("/")

    def complete(
        self,
        *,
        system_blocks: list[PromptBlock],
        user_text: str,
        max_tokens: int = 2048,
    ) -> CompletionResult:
        api_key = self._resolve_api_key()
        if not api_key:
            raise DeepSeekProviderConfigError(
                "No DeepSeek API key available — neither an explicit api_key nor "
                "DEEPSEEK_API_KEY is set — cannot call the real DeepSeek API."
            )

        body = {
            "model": self._model,
            "messages": _messages_from_blocks(system_blocks, user_text),
            "max_tokens": max_tokens,
            "temperature": 0,
            "stream": False,
        }
        url = f"{self._resolve_base_url()}/chat/completions"

        try:
            with httpx.Client(timeout=self._timeout_seconds) as client:
                response = client.post(url, headers={"Authorization": f"Bearer {api_key}"}, json=body)
        except httpx.HTTPError as exc:
            raise DeepSeekProviderUpstreamError(
                f"DeepSeek API call failed: {exc.__class__.__name__}"
            ) from exc

        if response.status_code >= 400:
            raise DeepSeekProviderUpstreamError(
                f"DeepSeek API call failed with status {response.status_code}"
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise DeepSeekProviderUpstreamError("DeepSeek API response was not valid JSON") from exc

        text = _extract_text(payload)
        usage = payload.get("usage") if isinstance(payload, dict) else None
        usage = usage if isinstance(usage, dict) else {}
        return CompletionResult(
            text=text,
            input_tokens=_int_or_none(usage.get("prompt_tokens")),
            output_tokens=_int_or_none(usage.get("completion_tokens")),
            cache_read_tokens=_int_or_none(usage.get("prompt_cache_hit_tokens")),
            cache_write_tokens=_int_or_none(usage.get("prompt_cache_miss_tokens")),
        )


def _messages_from_blocks(system_blocks: list[PromptBlock], user_text: str) -> list[dict[str, str]]:
    cacheable = [block.text for block in system_blocks if block.cacheable and block.text]
    uncached = [block.text for block in system_blocks if not block.cacheable and block.text]
    messages: list[dict[str, str]] = []
    system_text = "\n\n".join([*cacheable, *uncached])
    if system_text:
        messages.append({"role": "system", "content": system_text})
    messages.append({"role": "user", "content": user_text})
    return messages


def _extract_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise DeepSeekProviderUpstreamError("DeepSeek API response was not an object")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise DeepSeekProviderUpstreamError("DeepSeek API response contained no choices")
    first = choices[0]
    if not isinstance(first, dict):
        raise DeepSeekProviderUpstreamError("DeepSeek API response choice was not an object")
    message = first.get("message")
    if not isinstance(message, dict):
        raise DeepSeekProviderUpstreamError("DeepSeek API response choice contained no message")
    content = message.get("content")
    if not isinstance(content, str) or not content:
        raise DeepSeekProviderUpstreamError("DeepSeek API response contained no text content")
    return content


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


__all__ = [
    "DeepSeekProvider",
    "DeepSeekProviderConfigError",
    "DeepSeekProviderUpstreamError",
]
