"""Real FastAPI worker app: internal extraction + CAG review endpoints.

Both routes are internal-only (never exposed to the browser): the NestJS API
calls them server-side via `WORKER_BASE_URL`. Extraction is pure/local
(pypdf/python-docx); review calls out to an `LLMProvider` (real Claude in
production, a fake in tests — see `app/providers/`).
"""
from __future__ import annotations

from dataclasses import asdict

from fastapi import Depends, FastAPI, HTTPException, UploadFile
from pydantic import BaseModel

from .cag_review import CagReviewError, run_cag_review
from .extraction import ExtractionError, UnsupportedContentTypeError, extract_text
from .providers.anthropic_provider import AnthropicProvider, AnthropicProviderConfigError
from .providers.llm_provider import LLMProvider

WORKER_SERVICE_NAME = "pg1-document-ai-worker"


class ReviewRequest(BaseModel):
    thesis_text: str


def get_llm_provider() -> LLMProvider:
    # Constructing `AnthropicProvider()` never touches `ANTHROPIC_API_KEY` —
    # the key is only read inside `.generate()`, at actual call time.
    return AnthropicProvider()


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

    @app.post("/internal/review")
    def internal_review(
        payload: ReviewRequest, provider: LLMProvider = Depends(get_llm_provider)
    ):
        try:
            finding = run_cag_review(provider, payload.thesis_text)
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
