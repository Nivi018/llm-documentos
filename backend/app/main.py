from os import getenv
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from .block_summary import block_summary_router
from .document_query import ProviderName, document_query_router
from .docx_export import router as docx_router
from .ollama_provider import OllamaProvider
from .pdf import router as pdf_router
from .provider import create_provider
from .rewrite import rewrite_router
from .text_preview import router as text_preview_router


class HealthResponse(BaseModel):
    status: Literal["ok"]


class ProbeResponse(BaseModel):
    provider: ProviderName
    message: str


def create_app() -> FastAPI:
    provider_name, provider = create_provider(getenv("LLM_PROVIDER", "stub"))
    api = FastAPI(title="llm-documentos", version="0.1.0")
    api.include_router(pdf_router)
    api.include_router(text_preview_router)
    api.include_router(document_query_router(provider_name, provider))
    api.include_router(docx_router)
    api.include_router(
        block_summary_router(provider if isinstance(provider, OllamaProvider) else None)
    )
    api.include_router(
        rewrite_router(provider if isinstance(provider, OllamaProvider) else None)
    )

    @api.get("/api/health")
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @api.get("/api/provider/probe")
    def provider_probe() -> ProbeResponse:
        return ProbeResponse(provider=provider_name, message=provider.probe())

    return api
