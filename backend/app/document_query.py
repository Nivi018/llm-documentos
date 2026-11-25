from typing import Annotated, Literal, Protocol

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from .pdf import MAX_PAGES, MAX_TEXT

PageText = Annotated[str, Field(max_length=MAX_TEXT)]
ProviderName = Literal["stub", "opencode-console", "ollama"]
Question = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]


class QueryPage(BaseModel):
    number: int = Field(ge=1, le=MAX_PAGES)
    text: PageText


class DocumentQuery(BaseModel):
    pages: list[QueryPage] = Field(min_length=1, max_length=MAX_PAGES)


class AskDocument(DocumentQuery):
    action: Literal["ask"]
    question: Question


class SummarizeDocument(DocumentQuery):
    action: Literal["summarize"]


class Citation(BaseModel):
    page: int
    excerpt: str


class QueryResult(BaseModel):
    provider: ProviderName = "stub"
    status: Literal["answered", "not_found", "summarized"]
    citations: list[Citation]
    answer: str | None = None


class DocumentProvider(Protocol):
    def query(self, query: AskDocument | SummarizeDocument) -> QueryResult: ...


def document_query_router(
    provider_name: ProviderName, provider: DocumentProvider
) -> APIRouter:
    router = APIRouter()

    @router.post("/api/documents/query", response_model_exclude_none=True)
    def query_document(
        query: Annotated[
            AskDocument | SummarizeDocument, Field(discriminator="action")
        ],
        consent: Annotated[str | None, Header(alias="X-Document-Remote")] = None,
    ) -> QueryResult:
        if provider_name == "opencode-console" and consent != provider_name:
            raise HTTPException(403, "Confirma el envío de texto a OpenCode Console.")
        if [page.number for page in query.pages] != list(
            range(1, len(query.pages) + 1)
        ):
            raise HTTPException(422, "Los segmentos deben estar numerados en orden.")
        if sum(len(page.text) for page in query.pages) > MAX_TEXT:
            raise HTTPException(
                413, "El documento contiene demasiado texto para consultarlo."
            )
        if not any(page.text.strip() for page in query.pages):
            raise HTTPException(422, "El documento no contiene texto para consultar.")
        return provider.query(query)

    return router


def document_lines(pages: list[QueryPage]) -> list[Citation]:
    lines: list[Citation] = []
    for page in pages:
        unique: set[str] = set()
        for raw in page.text.splitlines():
            line = raw.strip()[:360]
            if not line or line in unique:
                continue
            unique.add(line)
            lines.append(Citation(page=page.number, excerpt=line))
    return lines
