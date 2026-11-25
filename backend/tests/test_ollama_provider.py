import json

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import provider
from app.main import create_app
from app.ollama_provider import ENDPOINT, OllamaProvider

URL = "/api/documents/query"


@pytest.mark.parametrize(
    ("question", "text", "answer", "excerpt", "calls", "status", "code"),
    [
        (
            "¿Cuál es el correo de la responsable?",
            "Responsable: Lucía",
            "Lucía",
            "Lucía",
            0,
            "not_found",
            200,
        ),
        (
            "¿Cuál es el correo?",
            "Lucía: lucia@example.org",
            "Lucía",
            "Lucía",
            1,
            "not_found",
            200,
        ),
        (
            "¿Cuál es el correo?",
            "Lucía: lucia@example.org",
            "lucia@example.org",
            "Lucía: lucia@example.org",
            1,
            "answered",
            200,
        ),
        (
            "¿Cuál es el correo?",
            "Lucía: lucia@example.org",
            "otra@example.org",
            "Lucía: lucia@example.org",
            1,
            "not_found",
            200,
        ),
        (
            "¿Cuál es el presupuesto?",
            "Presupuesto: USD 8.000",
            "USD 8.000",
            "USD 8.000",
            1,
            "answered",
            200,
        ),
        (
            "¿Cuál es el presupuesto?",
            "Presupuesto: USD 8.000",
            "USD 8.000",
            "USD 9.000",
            1,
            None,
            502,
        ),
        (
            "¿Cuál es el presupuesto?",
            "a" * 3000,
            "USD 8.000",
            "USD 8.000",
            0,
            "not_found",
            200,
        ),
    ],
)
def test_local_query(
    monkeypatch: pytest.MonkeyPatch,
    question: str,
    text: str,
    answer: str,
    excerpt: str,
    calls: int,
    status: str | None,
    code: int,
) -> None:
    count = 0

    def reply(request: httpx2.Request) -> httpx2.Response:
        nonlocal count
        count += 1
        assert str(request.url) == ENDPOINT
        assert "Authorization" not in request.headers
        payload = json.loads(request.content)
        assert payload["model"] == "qwen3:4b"
        assert payload["options"]["num_gpu"] == 0
        assert payload["options"]["num_ctx"] == 4096
        return httpx2.Response(
            200,
            json={
                "done": True,
                "done_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": json.dumps(
                        {
                            "answer": answer,
                            "citations": [{"page": 1, "excerpt": excerpt}],
                        }
                    ),
                },
            },
        )

    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setattr(
        provider, "OllamaProvider", lambda: OllamaProvider(httpx2.MockTransport(reply))
    )
    with TestClient(create_app()) as client:
        assert client.get("/api/provider/probe").json()["provider"] == "ollama"
        response = client.post(
            URL,
            json={
                "action": "ask",
                "question": question,
                "pages": [{"number": 1, "text": text}],
            },
        )
    assert count == calls
    assert response.status_code == code
    if status:
        assert response.json()["status"] == status
        assert response.json()["provider"] == "ollama"
        if status == "not_found":
            assert "answer" not in response.json()
