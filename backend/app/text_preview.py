from collections.abc import Iterable
from io import BytesIO
from zipfile import BadZipFile, ZipFile

from docx import Document
from docx.opc.exceptions import OpcError
from fastapi import APIRouter, HTTPException, Request

from .docx_export import DOCX_TYPE, INVALID_XML
from .pdf import MAX_PAGES, MAX_TEXT, PdfPage, PdfPreview, read_preview

MAX_EXPANDED_BYTES = 24 * 1024 * 1024
MAX_ZIP_ENTRIES = 1_000
router = APIRouter()


def build_preview(parts: Iterable[str], units: str) -> PdfPreview:
    pages: list[PdfPage] = []
    size = 0
    for number, text in enumerate(parts, 1):
        size += len(text)
        if number > MAX_PAGES:
            raise HTTPException(
                413, f"El documento supera el máximo de {MAX_PAGES} {units}."
            )
        if size > MAX_TEXT:
            raise HTTPException(
                413, "El documento contiene demasiado texto para la vista previa."
            )
        pages.append(PdfPage(number=number, text=text))
    if not any(page.text.strip() for page in pages):
        raise HTTPException(422, "No se encontró texto en el documento.")
    return PdfPreview(pages=pages)


def extract_docx(buffer: BytesIO) -> PdfPreview:
    try:
        with ZipFile(buffer) as archive:
            entries = archive.infolist()
            if (
                len(entries) > MAX_ZIP_ENTRIES
                or sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES
            ):
                raise HTTPException(
                    413, "El DOCX supera el límite de tamaño descomprimido."
                )
            if "word/document.xml" not in archive.namelist():
                raise ValueError
        buffer.seek(0)
        document = Document(buffer)
        return build_preview(
            (paragraph.text for paragraph in document.paragraphs), "párrafos"
        )
    except (
        BadZipFile,
        OpcError,
        KeyError,
        ValueError,
        OSError,
        SyntaxError,
        RuntimeError,
        NotImplementedError,
    ):
        raise HTTPException(422, "No se pudo leer el archivo DOCX.") from None


def extract_txt(buffer: BytesIO) -> PdfPreview:
    try:
        text = buffer.getvalue().decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(
            422, "Guarda el archivo TXT con codificación UTF-8."
        ) from None
    if INVALID_XML.search(text):
        raise HTTPException(422, "El TXT contiene caracteres de control no admitidos.")
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return build_preview(normalized.removesuffix("\n").split("\n", MAX_PAGES), "líneas")


def binary_body(media: str) -> dict[str, object]:
    return {
        "requestBody": {
            "required": True,
            "content": {media: {"schema": {"type": "string", "format": "binary"}}},
        }
    }


@router.post("/api/documents/docx/preview", openapi_extra=binary_body(DOCX_TYPE))
async def preview_docx(request: Request) -> PdfPreview:
    return await read_preview(request, DOCX_TYPE, "DOCX", extract_docx)


@router.post("/api/documents/txt/preview", openapi_extra=binary_body("text/plain"))
async def preview_txt(request: Request) -> PdfPreview:
    return await read_preview(request, "text/plain", "TXT", extract_txt)
