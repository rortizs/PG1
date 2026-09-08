"""LLM provider abstraction.

Any provider (Anthropic/Claude today; DeepSeek, Groq, etc. later) plugs into
the CAG review module through this cache-aware `complete` method — callers
never depend on a specific vendor SDK.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, cast, runtime_checkable

__all__ = [
    "CompletionResult",
    "LLMProvider",
    "LLMProviderError",
    "PromptBlock",
    "ProviderNotImplementedError",
]


@dataclass(frozen=True)
class PromptBlock:
    text: str
    cacheable: bool = False


@dataclass(frozen=True)
class CompletionResult:
    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None


class LLMProviderError(RuntimeError):
    """Base error for provider failures (config, network, upstream API)."""


class ProviderNotImplementedError(LLMProviderError):
    """Raised when a registered `provider_name` (DeepSeek, Groq, or any name
    not yet wired to a real implementation) is actually used to run a
    review. Registering/activating such a provider via the admin API is
    allowed (llm-provider-admin PR B); calling `.complete()` on it is not —
    this must fail loudly, never silently fall back to another provider, and
    never attempt a real network call."""


@runtime_checkable
class LLMProvider(Protocol):
    def complete(
        self,
        *,
        system_blocks: list[PromptBlock],
        user_text: str,
        max_tokens: int = 2048,
    ) -> CompletionResult:
        """Return the raw text completion and provider usage metadata.

        Implementations MUST raise `LLMProviderError` (or a subclass) on any
        failure — missing configuration, network error, or upstream API
        error — never return a fabricated/empty completion to mask a failure.
        """
        return cast(CompletionResult, None)
