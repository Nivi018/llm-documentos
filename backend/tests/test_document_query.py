from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import document_query
from app.main import create_app

URL = "/api/documents/query"
EXAMPLE = Path(__file__).resolve().parents[2] / "ejemplos/biblioteca-horizonte.pdf"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("LLM_PROVIDER", "stub")
    with TestClient(create_app()) as session:
        yield session


@pytest.fixture
def pages(client: TestClient) -> list[dict[str, Any]]:
    response = client.post(
        "/api/documents/pdf/preview",
        headers={"Content-Type": "application/pdf"},
        content=EXAMPLE.read_bytes(),
    )
    response.raise_for_status()
    result: list[dict[str, Any]] = response.json()["pages"]
    return result


@pytest.mark.parametrize(
    ("question", "page", "expected"),
    [
        ("¿Quién es la responsable del proyecto?", 1, "Lucía Méndez"),
        ("¿Dónde será el primer taller?", 2, "Plaza del Olmo"),
        ("¿Cuál es el presupuesto total aprobado?", 3, "USD 8.000"),
    ],
)
def test_cites_page(
    client: TestClient,
    pages: list[dict[str, Any]],
    question: str,
    page: int,
    expected: str,
) -> None:
    response = client.post(
        URL, json={"action": "ask", "pages": pages, "question": question}
    )
    assert response.status_code == 200
    result = response.json()
    assert result["provider"] == "stub"
    assert result["status"] == "answered"
    (citation,) = result["citations"]
    assert citation["page"] == page
    assert expected in citation["excerpt"]
    assert citation["excerpt"] in pages[page - 1]["text"]


def test_reports_missing_information(
    client: TestClient, pages: list[dict[str, Any]]
) -> None:
    response = client.post(
        URL,
        json={
            "action": "ask",
            "pages": pages,
            "question": "¿Cuál es el correo de la responsable?",
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "provider": "stub",
        "status": "not_found",
        "citations": [],
    }


def test_summarizes_with_existing_excerpts(
    client: TestClient, pages: list[dict[str, Any]]
) -> None:
    response = client.post(URL, json={"action": "summarize", "pages": pages})
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "summarized"
    assert {citation["page"] for citation in result["citations"]} == {1, 2, 3}
    assert any("USD 8.000" in citation["excerpt"] for citation in result["citations"])
    for citation in result["citations"]:
        assert citation["excerpt"] in pages[citation["page"] - 1]["text"]


@pytest.mark.parametrize(
    "payload",
    [
        {"action": "ask", "pages": [{"number": 1, "text": "Dato"}], "question": " "},
        {"action": "summarize", "pages": [{"number": 2, "text": "Dato"}]},
        {"action": "summarize", "pages": [{"number": 1, "text": " "}]},
    ],
)
def test_rejects_invalid_queries(client: TestClient, payload: dict[str, Any]) -> None:
    assert client.post(URL, json=payload).status_code == 422


def test_rejects_excessive_total_text(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(document_query, "MAX_TEXT", 3)
    payload = {"action": "summarize", "pages": [{"number": 1, "text": "Dato"}]}
    assert client.post(URL, json=payload).status_code == 413
