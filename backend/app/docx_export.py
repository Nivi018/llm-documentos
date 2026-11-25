import re
from io import BytesIO
from typing import Literal

from docx import Document
from fastapi import APIRouter, HTTPException, Response

from .document_query import DocumentQuery
from .pdf import MAX_TEXT

DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
INVALID_XML = re.compile(
    r"[^\x09\x0a\x0d\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]"
)

router = APIRouter()


class DocxExport(DocumentQuery):
    source_type: Literal["pdf", "docx", "txt"] = "pdf"


@router.post(
    "/api/documents/docx",
    response_class=Response,
    responses={
        200: {
            "content": {DOCX_TYPE: {"schema": {"type": "string", "format": "binary"}}}
        }
    },
)
def export_docx(payload: DocxExport) -> Response:
    pages = payload.pages
    if [page.number for page in pages] != list(range(1, len(pages) + 1)):
        raise HTTPException(422, "Los segmentos deben estar numerados en orden.")
    if sum(len(page.text) for page in pages) > MAX_TEXT:
        raise HTTPException(413, "La copia supera el límite de texto.")
    if any(INVALID_XML.search(page.text) for page in pages):
        raise HTTPException(422, "La copia contiene caracteres incompatibles con Word.")

    doc = Document()
    for page in pages:
        if payload.source_type == "pdf":
            heading = doc.add_heading(f"Página {page.number} del PDF", level=1)
            if page.number != 1:
                heading.paragraph_format.page_break_before = True
        doc.add_paragraph(page.text)
    with BytesIO() as output:
        doc.save(output)
        return Response(
            output.getvalue(),
            media_type=DOCX_TYPE,
            headers={
                "Content-Disposition": 'attachment; filename="documento-editado.docx"',
                "Cache-Control": "no-store",
            },
        )
