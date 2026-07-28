"""Registry-only providers (llm-provider-admin Work Unit 6).

DeepSeek and Groq are valid `provider_name` values at the admin-CRUD layer
(an admin can create/activate a row for either today), but neither has a
real implementation yet. These providers exist so that using one to actually
run a review fails LOUDLY and explicitly — inside `.generate()`, exactly
like `AnthropicProviderConfigError` fails inside `AnthropicProvider.generate()`
— never silently falling back to Claude, and never attempting a real network
call.
"""
from __future__ import annotations

from .llm_provider import ProviderNotImplementedError


class UnimplementedProvider:
    """A provider that is registered/selectable but has no real backend yet.

    `api_key`/`model` are accepted (matching every other provider's
    constructor shape) but intentionally unused — no credential is ever
    touched or sent anywhere for a provider that never actually calls out.
    """

    def __init__(self, name: str, *, api_key: str | None = None, model: str | None = None) -> None:
        self._name = name
        self._model = model

    def generate(self, prompt: str, *, max_tokens: int = 1024) -> str:
        raise ProviderNotImplementedError(
            f"{self._name} provider is not yet implemented — no real API call was attempted."
        )


class DeepSeekProvider(UnimplementedProvider):
    def __init__(self, *, api_key: str | None = None, model: str | None = None) -> None:
        super().__init__("deepseek", api_key=api_key, model=model)


class GroqProvider(UnimplementedProvider):
    def __init__(self, *, api_key: str | None = None, model: str | None = None) -> None:
        super().__init__("groq", api_key=api_key, model=model)
