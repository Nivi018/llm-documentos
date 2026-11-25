from collections.abc import Iterator
from io import BytesIO
from pathlib import Path

import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.docx_export import DOCX_TYPE
from app.main import create_app

EXAMPLES = Path(__file__).resolve().parents[2] / "ejemplos"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("LLM_PROVIDER", "stub")
    with TestClient(create_app()) as session:
        yield session


@pytest.mark.parametrize(
    ("kind", "name", "media"),
    [
        ("docx", "huerto-del-barrio.docx", DOCX_TYPE),
        ("txt", "huerto-del-barrio.txt", "text/plain"),
    ],
)
def test_load_query_and_export_copy(
    client: TestClient, kind: str, name: str, media: str
) -> None:
    source = EXAMPLES / name
    original = source.read_bytes()
    response = client.post(
        f"/api/documents/{kind}/preview",
        content=original,
        headers={"Content-Type": media},
    )
    assert response.status_code == 200
    pages = response.json()["pages"]
    assert len(pages) == 5
    assert pages[1] == {"number": 2, "text": "Responsable: Inés Valdés."}
    assert pages[3] == {"number": 4, "text": "Presupuesto total aprobado: USD 2.400."}

    query = client.post(
        "/api/documents/query",
        json={
            "pages": pages,
            "action": "ask",
            "question": "¿Cuál es el presupuesto total aprobado?",
        },
    )
    assert query.status_code == 200
    assert query.json()["citations"] == [{"page": 4, "excerpt": pages[3]["text"]}]
    summary = client.post(
        "/api/documents/query", json={"pages": pages, "action": "summarize"}
    )
    assert summary.json()["status"] == "summarized"

    pages[3]["text"] = pages[3]["text"].replace("USD 2.400", "USD 2.750")
    exported = client.post(
        "/api/documents/docx", json={"pages": pages, "source_type": kind}
    )
    assert exported.status_code == 200
    assert exported.headers["content-type"] == DOCX_TYPE
    copy = Document(BytesIO(exported.content))
    assert [paragraph.text for paragraph in copy.paragraphs] == [
        p["text"] for p in pages
    ]
    assert source.read_bytes() == original


def test_txt_keeps_blank_line_numbers_and_accepts_bom(client: TestClient) -> None:
    result = client.post(
        "/api/documents/txt/preview",
        content="uno\r\n\r\ntres\r\n".encode("utf-8-sig"),
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )
    assert result.json()["pages"][2] == {"number": 3, "text": "tres"}
    assert result.json()["pages"][1]["text"] == ""


@pytest.mark.parametrize(
    ("kind", "payload", "content_type", "status"),
    [
        ("docx", b"not a zip", DOCX_TYPE, 422),
        ("txt", b"\xff", "text/plain", 422),
        ("txt", b"\n \n", "text/plain", 422),
        ("txt", b"a\x00b", "text/plain", 422),
        ("txt", b"a\n" * 101, "text/plain", 413),
        ("txt", b"hello", "application/pdf", 415),
    ],
)
def test_rejects_invalid_input(
    client: TestClient, kind: str, payload: bytes, content_type: str, status: int
) -> None:
    response = client.post(
        f"/api/documents/{kind}/preview",
        content=payload,
        headers={"Content-Type": content_type},
    )
    assert response.status_code == status
