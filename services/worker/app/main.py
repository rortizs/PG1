"""Real FastAPI worker app: internal extraction + CAG review endpoints.

Both routes are internal-only (never exposed to the browser): the NestJS API
calls them server-side via `WORKER_BASE_URL`. Extraction is pure/local
(pypdf/python-docx); review calls out to an `LLMProvider` (real Claude in
production, a fake in tests — see `app/providers/`).
"""
from __future__ import annotations

from dataclasses import asdict

from fastapi import Depends, FastAPI, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .cag_review import CagReviewError, run_cag_review
from .extraction import ExtractionError, UnsupportedContentTypeError, extract_text
from .providers.anthropic_provider import AnthropicProvider, AnthropicProviderConfigError
from .providers.llm_provider import LLMProvider, ProviderNotImplementedError
from .providers.unimplemented_provider import DeepSeekProvider, GroqProvider, UnimplementedProvider
from .rules import run_rules

WORKER_SERVICE_NAME = "pg1-document-ai-worker"

# `llm_provider_config.provider_name` at the admin-CRUD layer is restricted
# to exactly these three values (see 0002_llm_provider_config.sql's CHECK
# constraint) — kept in sync here for the worker's own selection logic.
SUPPORTED_PROVIDER_NAMES = ("claude", "deepseek", "groq")


class RagContextItem(BaseModel):
    segment_id: int | None = None
    source_ref: str
    segment_text: str
    similarity_score: float | None = None


class ReviewRequest(BaseModel):
    thesis_text: str
    # llm-provider-admin (Work Unit 5): the API resolves the DB-active
    # provider per review-run-trigger and forwards these three fields.
    # All optional — omitting them keeps the pre-existing Claude+env-var
    # behavior working unchanged (design decision #11, rollback/local-dev).
    provider_name: str | None = None
    api_key: str | None = None
    model_id: str | None = None
    rag_context: list[RagContextItem] = Field(default_factory=list)


class PageInput(BaseModel):
    """Precise-thesis-review-pipeline Work Unit 5: same per-page shape
    `/internal/extract` returns — `/internal/rules` is the second, fully
    independent consumer of that shape (design.md's flow diagram)."""

    page_number: int | None = None
    section_title: str | None = None
    text: str = ""


class SectionInput(BaseModel):
    index: int
    parent_index: int | None = None
    section_type: str
    title: str | None = None
    normalized_title: str | None = None
    start_page_number: int | None = None
    end_page_number: int | None = None
    start_offset: int | None = None
    end_offset: int | None = None
    is_location_uncertain: bool = False
    metadata: dict = Field(default_factory=dict)


class RulesRequest(BaseModel):
    pages: list[PageInput] = Field(default_factory=list)
    sections: list[SectionInput] = Field(default_factory=list)


def select_llm_provider(
    provider_name: str | None, api_key: str | None, model_id: str | None
) -> LLMProvider:
    """Selects (never fails here) the provider implementation for a review
    request. Any failure — DeepSeek/Groq not implemented, or an unknown
    provider_name — is deferred to `.generate()` so it is always caught by
    `internal_review`'s try/except below, never left unhandled at FastAPI's
    dependency-resolution stage.
    """
    name = (provider_name or "claude").strip().lower()
    if name == "claude":
        if model_id is not None:
            return AnthropicProvider(model=model_id, api_key=api_key)
        return AnthropicProvider(api_key=api_key)
    if name == "deepseek":
        return DeepSeekProvider(api_key=api_key, model=model_id)
    if name == "groq":
        return GroqProvider(api_key=api_key, model=model_id)
    # Defensive: the admin API already restricts provider_name to
    # SUPPORTED_PROVIDER_NAMES, so this branch should be unreachable in
    # normal operation — but never silently coerce an unknown name to
    # Claude, and never crash unhandled either.
    return UnimplementedProvider(provider_name or "unknown", api_key=api_key, model=model_id)


def get_llm_provider(payload: ReviewRequest) -> LLMProvider:
    # Constructing the returned provider never makes a network call — the
    # key/credential is only read/required inside `.generate()`, at actual
    # call time (unchanged contract from before this pass).
    return select_llm_provider(payload.provider_name, payload.api_key, payload.model_id)


def create_app() -> FastAPI:
    app = FastAPI(title=WORKER_SERVICE_NAME)

    @app.post("/internal/extract")
    async def internal_extract(file: UploadFile):
        data = await file.read()
        try:
            result = extract_text(
                filename=file.filename or "upload",
                content_type=file.content_type or "",
                data=data,
            )
        except UnsupportedContentTypeError as exc:
            raise HTTPException(status_code=415, detail=str(exc)) from exc
        except ExtractionError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return result.to_dict()

    @app.post("/internal/rules")
    def internal_rules(payload: RulesRequest):
        """Precise-thesis-review-pipeline Work Unit 5 (design.md D9):
        structurally incapable of an LLM call — `app.rules` imports nothing
        from `app.providers` (see `tests/test_rules.py::ImportBoundaryTest`
        and `tests/test_review_endpoint.py`'s provider-call-spy proof), so
        this route has an independent failure domain from `/internal/review`.
        """
        pages = [page.model_dump() for page in payload.pages]
        sections = [section.model_dump() for section in payload.sections]
        findings = run_rules(pages, sections)
        return {"findings": [asdict(finding) for finding in findings]}

    @app.post("/internal/review")
    def internal_review(
        payload: ReviewRequest, provider: LLMProvider = Depends(get_llm_provider)
    ):
        try:
            finding = run_cag_review(
                provider,
                payload.thesis_text,
                retrieved_context=[item.model_dump() for item in payload.rag_context],
            )
        except ProviderNotImplementedError as exc:
            raise HTTPException(
                status_code=501, detail=f"not_implemented: {exc}"
            ) from exc
        except AnthropicProviderConfigError as exc:
            raise HTTPException(
                status_code=500, detail=f"configuration_error: {exc}"
            ) from exc
        except CagReviewError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        if finding is None:
            return {"finding": None}
        return {"finding": asdict(finding)}

    return app


app = create_app()
