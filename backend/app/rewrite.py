from typing import Annotated

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from .docx_export import INVALID_XML
from .ollama_provider import MAX_INPUT_BYTES, OllamaProvider, RewriteProposal


class RewriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=MAX_INPUT_BYTES)
    instruction: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
    ]


def rewrite_router(provider: OllamaProvider | None) -> APIRouter:
    router = APIRouter()

    @router.post("/api/documents/rewrite")
    def rewrite_fragment(payload: RewriteRequest) -> RewriteProposal:
        if provider is None:
            raise HTTPException(409, "La reescritura requiere activar Ollama local.")
        if (
            not payload.text.strip()
            or INVALID_XML.search(payload.text)
            or INVALID_XML.search(payload.instruction)
        ):
            raise HTTPException(
                422, "El fragmento o la instrucción no contienen texto válido."
            )
        proposal = provider.rewrite(payload.text, payload.instruction)
        if INVALID_XML.search(proposal.text):
            raise HTTPException(
                502, "La propuesta contiene caracteres incompatibles con Word."
            )
        return proposal

    return router
