from collections.abc import Callable
from io import BytesIO

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from pypdf import PdfReader
from pypdf.errors import PyPdfError
from starlette.concurrency import run_in_threadpool

MAX_BYTES = 10 * 1024 * 1024
MAX_PAGES = 100
MAX_TEXT = 500_000

router = APIRouter()


class PdfPage(BaseModel):
    number: int
    text: str


class PdfPreview(BaseModel):
    pages: list[PdfPage]


def extract_pdf(buffer: BytesIO) -> PdfPreview:
    buffer.seek(0)
    if buffer.read(5) != b"%PDF-":
        raise HTTPException(422, "El archivo no es un PDF válido.")
    buffer.seek(0)
    try:
        with PdfReader(buffer, strict=True) as reader:
            if reader.is_encrypted:
                raise HTTPException(422, "No se admiten PDF protegidos con contraseña.")
            count = len(reader.pages)
            if count > MAX_PAGES:
                raise HTTPException(
                    413, f"El PDF supera el máximo de {MAX_PAGES} páginas."
                )
            if not count:
                raise HTTPException(422, "El PDF no contiene páginas.")

            pages: list[PdfPage] = []
            total = 0
            for number, page in enumerate(reader.pages, 1):
                text = page.extract_text().strip()
                total += len(text)
                if total > MAX_TEXT:
                    raise HTTPException(
                        413, "El PDF contiene demasiado texto para la vista previa."
                    )
                pages.append(PdfPage(number=number, text=text))
            return PdfPreview(pages=pages)
    except (PyPdfError, ValueError, RecursionError, NotImplementedError) as exc:
        raise HTTPException(
            422, "No se pudo leer el PDF. Puede estar dañado o no ser compatible."
        ) from exc


@router.post(
    "/api/documents/pdf/preview",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/pdf": {"schema": {"type": "string", "format": "binary"}}
            },
        },
    },
)
async def preview_pdf(request: Request) -> PdfPreview:
    return await read_preview(request, "application/pdf", "PDF", extract_pdf)


async def read_preview(
    request: Request,
    expected_type: str,
    label: str,
    extract: Callable[[BytesIO], PdfPreview],
) -> PdfPreview:
    media_type = (
        request.headers.get("content-type", "").partition(";")[0].strip().lower()
    )
    if media_type != expected_type:
        raise HTTPException(415, f"Solo se admiten archivos {label} en esta ruta.")
    with BytesIO() as buffer:
        async for chunk in request.stream():
            if buffer.tell() + len(chunk) > MAX_BYTES:
                raise HTTPException(413, "El archivo supera el máximo de 10 MiB.")
            buffer.write(chunk)
        return await run_in_threadpool(extract, buffer)
