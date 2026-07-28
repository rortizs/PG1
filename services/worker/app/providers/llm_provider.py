"""LLM provider abstraction.

Any provider (Anthropic/Claude today; DeepSeek, Groq, etc. later) plugs into
the CAG review module through this single `generate` method — callers never
depend on a specific vendor SDK.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable


class LLMProviderError(RuntimeError):
    """Base error for provider failures (config, network, upstream API)."""


class ProviderNotImplementedError(LLMProviderError):
    """Raised when a registered `provider_name` (DeepSeek, Groq, or any name
    not yet wired to a real implementation) is actually used to run a
    review. Registering/activating such a provider via the admin API is
    allowed (llm-provider-admin PR B); calling `.generate()` on it is not —
    this must fail loudly, never silently fall back to another provider, and
    never attempt a real network call."""


@runtime_checkable
class LLMProvider(Protocol):
    def generate(self, prompt: str, *, max_tokens: int = 1024) -> str:
        """Return the raw text completion for the given prompt.

        Implementations MUST raise `LLMProviderError` (or a subclass) on any
        failure — missing configuration, network error, or upstream API
        error — never return a fabricated/empty string to mask a failure.
        """
        ...
