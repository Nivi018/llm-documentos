from collections.abc import Iterator
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from app import pdf
from app.main import create_app

URL = "/api/documents/pdf/preview"
HEADERS = {"Content-Type": "application/pdf"}
EXAMPLE = Path(__file__).resolve().parents[2] / "ejemplos/biblioteca-horizonte.pdf"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("LLM_PROVIDER", "stub")
    with TestClient(create_app()) as session:
        yield session


def blank_pdf(pages: int, *, encrypted: bool = False) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=100, height=100)
    if encrypted:
        writer.encrypt("test-only")
    with BytesIO() as buffer:
        writer.write(buffer)
        return buffer.getvalue()


def test_extracts_example_by_page(client: TestClient) -> None:
    response = client.post(URL, headers=HEADERS, content=EXAMPLE.read_bytes())
    assert response.status_code == 200
    pages = response.json()["pages"]
    assert [page["number"] for page in pages] == [1, 2, 3]
    assert "Lucía Méndez" in pages[0]["text"]
    assert "Plaza del Olmo" in pages[1]["text"]
    assert "USD 8.000" in pages[2]["text"]


def test_reports_pages_without_text(client: TestClient) -> None:
    response = client.post(URL, headers=HEADERS, content=blank_pdf(1))
    assert response.status_code == 200
    assert response.json() == {"pages": [{"number": 1, "text": ""}]}


@pytest.mark.parametrize("data", [b"", b"plain text", b"%PDF-1.4\nbroken"])
def test_rejects_invalid_pdf(client: TestClient, data: bytes) -> None:
    assert client.post(URL, headers=HEADERS, content=data).status_code == 422


def test_rejects_wrong_type(client: TestClient) -> None:
    assert client.post(URL, content=b"plain text").status_code == 415


def test_rejects_encrypted_pdf(client: TestClient) -> None:
    response = client.post(URL, headers=HEADERS, content=blank_pdf(1, encrypted=True))
    assert response.status_code == 422
    assert "contraseña" in response.json()["detail"]


def test_rejects_oversized_stream(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(pdf, "MAX_BYTES", 8)
    assert (
        client.post(URL, headers=HEADERS, content=iter([b"%PDF-", b"1234"])).status_code
        == 413
    )


def test_rejects_too_many_pages(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(pdf, "MAX_PAGES", 1)
    assert client.post(URL, headers=HEADERS, content=blank_pdf(2)).status_code == 413


def test_rejects_excessive_text(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(pdf, "MAX_TEXT", 10)
    assert (
        client.post(URL, headers=HEADERS, content=EXAMPLE.read_bytes()).status_code
        == 413
    )
