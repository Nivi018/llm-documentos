import json
from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import provider
from app.document_query import QueryPage
from app.main import create_app
from app.ollama_provider import MAX_INPUT_BYTES, OllamaProvider
from app.retrieval import encode_document, retrieve

EXAMPLE = Path(__file__).resolve().parents[2] / "ejemplos/piloto-archivo-largo.pdf"
QUESTION = "¿Cuál es el código del acta de recepción del piloto?"
EVIDENCE = "Código del acta de recepción del piloto: HZ-47Q-2027."


def test_finds_literal_passage_late_in_long_segment_and_respects_utf8_budget() -> None:
    text = "Revisión de cartelería en el barrio. " * 200 + EVIDENCE
    hits = retrieve(QUESTION, [QueryPage(number=21, text=text)], 900)
    assert hits[0]["page"] == 21
    assert EVIDENCE in hits[0]["text"]
    assert all(hit["text"] in text for hit in hits)
    assert len(encode_document(QUESTION, hits).encode("utf-8")) <= 900


@pytest.mark.parametrize("invented", [False, True])
def test_long_pdf_sends_relevant_fragments_with_original_page(
    monkeypatch: pytest.MonkeyPatch, invented: bool
) -> None:
    seen = 0

    def chat(request: httpx2.Request) -> httpx2.Response:
        nonlocal seen
        seen += 1
        prompt = json.loads(request.content)["messages"][1]["content"]
        snippets = json.loads(prompt)["document"]
        assert len(prompt.encode("utf-8")) <= MAX_INPUT_BYTES
        assert snippets[0]["page"] == 13 and EVIDENCE in snippets[0]["text"]
        assert not any(hit["page"] == 1 for hit in snippets)
        result = {
            "answer": "HZ-47Q-2:2027",
            "citations": [
                {"page": 1, "excerpt": "Registro de actividades comunitarias"}
                if invented
                else {"page": 13, "excerpt": EVIDENCE}
            ],
        }
        return httpx2.Response(
            200,
            json={
                "done": True,
                "done_reason": "stop",
                "message": {"role": "assistant", "content": json.dumps(result)},
            },
        )

    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setattr(
        provider, "OllamaProvider", lambda: OllamaProvider(httpx2.MockTransport(chat))
    )
    with TestClient(create_app()) as client:
        preview = client.post(
            "/api/documents/pdf/preview",
            content=EXAMPLE.read_bytes(),
            headers={"Content-Type": "application/pdf"},
        )
        preview.raise_for_status()
        pages = preview.json()["pages"]
        assert len(pages) == 13
        assert "Registro de actividades comunitarias" in pages[0]["text"]
        assert (
            sum(len(page["text"].encode("utf-8")) for page in pages) > MAX_INPUT_BYTES
        )
        url = "/api/documents/query"
        assert (
            client.post(url, json={"action": "summarize", "pages": pages}).status_code
            == 413
        )
        no_match = client.post(
            url,
            json={"action": "ask", "question": "¿Cuántos telescopios?", "pages": pages},
        )
        assert no_match.json()["status"] == "not_found"
        assert seen == 0
        result = client.post(
            url, json={"action": "ask", "question": QUESTION, "pages": pages}
        )
        assert seen == 1
        assert result.status_code == (502 if invented else 200)
        if not invented:
            assert result.json()["answer"] == "HZ-47Q-2027"
            assert result.json()["citations"] == [{"page": 13, "excerpt": EVIDENCE}]
