from io import BytesIO
from pathlib import Path

import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.docx_export import DOCX_TYPE
from app.main import create_app

URL = "/api/documents/docx"
EXAMPLE = Path(__file__).resolve().parents[2] / "ejemplos/biblioteca-horizonte.pdf"


def test_downloads_revised_word_without_changing_pdf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "stub")
    original = EXAMPLE.read_bytes()
    with TestClient(create_app()) as client:
        preview = client.post(
            "/api/documents/pdf/preview",
            headers={"Content-Type": "application/pdf"},
            content=original,
        )
        preview.raise_for_status()
        pages = preview.json()["pages"]
        assert "USD 8.000" in pages[2]["text"]
        pages[2]["text"] = pages[2]["text"].replace("USD 8.000", "USD 8.500")
        response = client.post(URL, json={"pages": pages})

    assert response.status_code == 200
    assert response.headers["content-type"] == DOCX_TYPE
    assert "attachment" in response.headers["content-disposition"]
    document = Document(BytesIO(response.content))
    text = "\n".join(paragraph.text for paragraph in document.paragraphs)
    assert "Lucía Méndez" in text
    assert "Página 3 del PDF" in text
    assert "USD 8.500" in text
    assert "USD 8.000" not in text
    assert EXAMPLE.read_bytes() == original


@pytest.mark.parametrize(
    "pages",
    [
        [{"number": 2, "text": "Página desordenada"}],
        [{"number": 1, "text": "Texto inválido\x00"}],
    ],
)
def test_rejects_invalid_content(
    monkeypatch: pytest.MonkeyPatch, pages: list[dict[str, str | int]]
) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "stub")
    with TestClient(create_app()) as client:
        assert client.post(URL, json={"pages": pages}).status_code == 422
