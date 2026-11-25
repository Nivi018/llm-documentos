import json
import re
from typing import Annotated

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from .document_query import (
    Citation,
    DocumentQuery,
    QueryPage,
    QueryResult,
    SummarizeDocument,
)
from .ollama_provider import BLOCK_SUMMARY_TASK, MAX_INPUT_BYTES, OllamaProvider
from .pdf import MAX_TEXT
from .retrieval import encode_document

MAX_BLOCKS = 8
REFERENCE_SUFFIX = re.compile(
    r"\s*(?:Citas|Referencias):\s*B\d+C\d+(?:\s*[,;]\s*B\d+C\d+)*[.\s]*\Z",
    re.IGNORECASE,
)


class SummaryPlan(BaseModel):
    blocks: list[DocumentQuery]


class BlockDigest(BaseModel):
    answer: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)
    ]
    citations: list[Citation] = Field(min_length=1, max_length=8)


class SynthesisRequest(DocumentQuery):
    blocks: list[BlockDigest] = Field(min_length=1, max_length=MAX_BLOCKS)


def fits(pages: list[QueryPage]) -> bool:
    content = encode_document(
        BLOCK_SUMMARY_TASK,
        [{"page": page.number, "text": page.text} for page in pages],
    )
    return len(content.encode("utf-8")) <= MAX_INPUT_BYTES


def make_plan(pages: list[QueryPage]) -> SummaryPlan:
    blocks: list[DocumentQuery] = []
    current: list[QueryPage] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        if len(blocks) >= MAX_BLOCKS:
            raise HTTPException(
                413,
                f"El documento necesita más de {MAX_BLOCKS} bloques. Divide el archivo y vuelve a intentarlo.",
            )
        blocks.append(DocumentQuery(pages=current))
        current = []

    for page in pages:
        text = page.text
        if not text.strip():
            continue
        # Check a bounded prefix first to avoid encoding a very large segment.
        if len(text) <= MAX_INPUT_BYTES and fits([*current, page]):
            current.append(page)
            continue
        flush()
        offset = 0
        while offset < len(text):
            limit = min(len(text) - offset, MAX_INPUT_BYTES)
            low, high = 1, limit
            while low <= high:
                middle = (low + high) // 2
                candidate = page.model_copy(
                    update={"text": text[offset : offset + middle]}
                )
                if fits([candidate]):
                    low = middle + 1
                else:
                    high = middle - 1
            end = offset + high
            if end < len(text):
                boundary = max(
                    text.rfind("\n", offset + high // 2, end),
                    text.rfind(" ", offset + high // 2, end),
                )
                if boundary >= 0:
                    end = boundary + 1
            chunk = text[offset:end]
            if chunk.strip():
                current = [page.model_copy(update={"text": chunk})]
            offset = end
            if offset < len(text):
                flush()
    flush()
    if not blocks:
        raise HTTPException(422, "El documento no contiene texto para resumir.")
    return SummaryPlan(blocks=blocks)


def plan_document(document: DocumentQuery) -> SummaryPlan:
    if [page.number for page in document.pages] != list(
        range(1, len(document.pages) + 1)
    ):
        raise HTTPException(422, "Los segmentos deben estar numerados en orden.")
    if sum(len(page.text) for page in document.pages) > MAX_TEXT:
        raise HTTPException(
            413, "El documento contiene demasiado texto para resumirlo."
        )
    return make_plan(document.pages)


def synthesize_document(
    provider: OllamaProvider, payload: SynthesisRequest
) -> QueryResult:
    planned = plan_document(payload).blocks
    if len(payload.blocks) != len(planned):
        raise HTTPException(
            422, "El resumen global requiere todos los bloques del documento."
        )
    groups: list[list[Citation]] = []
    for block, digest in zip(planned, payload.blocks, strict=True):
        valid: dict[tuple[int, str], Citation] = {}
        for citation in digest.citations:
            if (
                not citation.excerpt.strip()
                or len(citation.excerpt) > 600
                or not any(
                    page.number == citation.page and citation.excerpt in page.text
                    for page in block.pages
                )
            ):
                raise HTTPException(
                    422, "Una cita no coincide con su bloque del documento original."
                )
            valid[(citation.page, citation.excerpt)] = citation
        # Prefer sources near the end of each block, where conclusions often appear.
        groups.append(sorted(valid.values(), key=lambda citation: -citation.page))

    for answer_size, excerpt_size, per_block in (
        (520, 220, 3),
        (250, 130, 2),
        (115, 95, 1),
        (40, 35, 1),
    ):
        inputs = []
        allowed: dict[str, tuple[int, Citation]] = {}
        for number, (digest, group) in enumerate(
            zip(payload.blocks, groups, strict=True), 1
        ):
            sources = []
            for index, citation in enumerate(group[:per_block], 1):
                identifier = f"B{number}C{index}"
                allowed[identifier] = (number, citation)
                sources.append(
                    {"id": identifier, "texto": citation.excerpt[:excerpt_size]}
                )
            inputs.append(
                {
                    "bloque": number,
                    "resumen": digest.answer[:answer_size],
                    "citas": sources,
                }
            )
        content = json.dumps(
            {"bloques": inputs}, ensure_ascii=False, separators=(",", ":")
        )
        if len(content.encode("utf-8")) <= MAX_INPUT_BYTES:
            break
    else:
        raise HTTPException(
            413, "Los resúmenes de los bloques no caben en el contexto local."
        )

    proposal = provider.synthesize(content)
    ids = set(proposal.references)
    if not ids.issubset(allowed) or {allowed[key][0] for key in ids} != set(
        range(1, len(groups) + 1)
    ):
        raise HTTPException(
            502,
            "Ollama no citó todos los bloques de forma verificable. Los resúmenes parciales siguen disponibles.",
        )
    citations: dict[tuple[int, str], Citation] = {}
    for key, (_, citation) in allowed.items():
        if key in ids:
            citations[(citation.page, citation.excerpt)] = citation
    answer = REFERENCE_SUFFIX.sub("", proposal.answer).strip()
    if not answer:
        raise HTTPException(502, "Ollama no devolvió texto para el resumen global.")
    return QueryResult(
        provider="ollama",
        status="summarized",
        answer=answer,
        citations=sorted(citations.values(), key=lambda citation: citation.page),
    )


def block_summary_router(provider: OllamaProvider | None) -> APIRouter:
    router = APIRouter()

    @router.post("/api/documents/summary/plan")
    def plan_summary(document: DocumentQuery) -> SummaryPlan:
        if provider is None:
            raise HTTPException(
                409, "El resumen por bloques requiere activar Ollama local."
            )
        return plan_document(document)

    @router.post("/api/documents/summary/global", response_model_exclude_none=True)
    def summarize_global(payload: SynthesisRequest) -> QueryResult:
        if provider is None:
            raise HTTPException(409, "El resumen global requiere activar Ollama local.")
        return synthesize_document(provider, payload)

    @router.post("/api/documents/summary/block", response_model_exclude_none=True)
    def summarize_block(block: DocumentQuery) -> QueryResult:
        if provider is None:
            raise HTTPException(
                409, "El resumen por bloques requiere activar Ollama local."
            )
        numbers = [page.number for page in block.pages]
        if numbers != sorted(set(numbers)) or not all(
            page.text.strip() for page in block.pages
        ):
            raise HTTPException(
                422, "El bloque debe contener segmentos con texto y números en orden."
            )
        if not fits(block.pages):
            raise HTTPException(413, "El bloque supera el límite de contexto.")
        return provider.query(
            SummarizeDocument(action="summarize", pages=block.pages), block=True
        )

    return router
