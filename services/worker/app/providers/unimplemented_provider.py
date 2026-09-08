"""Registry-only providers without real worker backends yet.

Groq and any unknown registered provider fail LOUDLY and explicitly inside
`.complete()` — never silently falling back to Claude, and never attempting a
real network call.
"""
from __future__ import annotations

from .llm_provider import CompletionResult, PromptBlock, ProviderNotImplementedError


class UnimplementedProvider:
    """A provider that is registered/selectable but has no real backend yet.

    `api_key`/`model` are accepted (matching every other provider's
    constructor shape) but intentionally unused — no credential is ever
    touched or sent anywhere for a provider that never actually calls out.
    """

    def __init__(self, name: str, *, api_key: str | None = None, model: str | None = None) -> None:
        self._name = name
        self._model = model

    def complete(
        self,
        *,
        system_blocks: list[PromptBlock],
        user_text: str,
        max_tokens: int = 2048,
    ) -> CompletionResult:
        raise ProviderNotImplementedError(
            f"{self._name} provider is not yet implemented — no real API call was attempted."
        )


class GroqProvider(UnimplementedProvider):
    def __init__(self, *, api_key: str | None = None, model: str | None = None) -> None:
        super().__init__("groq", api_key=api_key, model=model)
