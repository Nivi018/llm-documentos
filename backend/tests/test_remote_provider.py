import json
from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import provider
from app.main import create_app
from app.remote_provider import ENDPOINT, ConsoleProvider

EXAMPLE = Path(__file__).resolve().parents[2] / "ejemplos/biblioteca-horizonte.pdf"
HEADERS = {"X-Document-Remote": "opencode-console"}
URL = "/api/documents/query"


def test_console_requires_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "opencode-console")
    monkeypatch.delenv("OPENCODE_API_KEY", raising=False)
    with pytest.raises(ValueError, match="OPENCODE_API_KEY"):
        create_app()


def test_luna_contract_with_example_pdf(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        payload = json.loads(request.content)
        assert str(request.url) == ENDPOINT
        assert request.headers["Authorization"] == "Bearer fake-key"
        assert payload["model"] == "gpt-6-luna"
        assert payload["store"] is False
        assert payload["text"]["format"]["strict"] is True
        document = json.loads(payload["input"])
        assert len(document["pages"]) == 3
        assert "USD 8.000" in document["pages"][2]["text"]
        question = document.get("question", "")
        calls.append(document["action"])
        result: dict[str, object]
        if "correo" in question:
            result = {"answer": None, "citations": []}
        else:
            amount = "USD 99.000" if "inventada" in question else "USD 8.000"
            result = {
                "answer": "El presupuesto aprobado fue de USD 8.000.",
                "citations": [{"page": 3, "excerpt": amount}],
            }
        return httpx2.Response(
            200,
            json={
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {"type": "output_text", "text": json.dumps(result)}
                        ],
                    }
                ],
            },
        )

    monkeypatch.setenv("LLM_PROVIDER", "opencode-console")
    monkeypatch.setenv("OPENCODE_API_KEY", "fake-key")
    monkeypatch.setattr(
        provider,
        "ConsoleProvider",
        lambda key: ConsoleProvider(key, httpx2.MockTransport(handle)),
    )
    with TestClient(create_app()) as client:
        probe = client.get("/api/provider/probe")
        assert probe.json()["provider"] == "opencode-console"
        assert "fake-key" not in probe.text
        preview = client.post(
            "/api/documents/pdf/preview",
            content=EXAMPLE.read_bytes(),
            headers={"Content-Type": "application/pdf"},
        )
        assert preview.status_code == 200
        pages = preview.json()["pages"]
        ask = {
            "action": "ask",
            "pages": pages,
            "question": "¿Cuánto dinero se autorizó para el piloto?",
        }
        assert client.post(URL, json=ask).status_code == 403
        assert calls == []

        response = client.post(URL, json=ask, headers=HEADERS)
        assert response.status_code == 200
        assert response.json() == {
            "provider": "opencode-console",
            "status": "answered",
            "answer": "El presupuesto aprobado fue de USD 8.000.",
            "citations": [{"page": 3, "excerpt": "USD 8.000"}],
        }

        missing = client.post(
            URL,
            json={**ask, "question": "¿Cuál es el correo de la responsable?"},
            headers=HEADERS,
        )
        assert missing.json()["status"] == "not_found"
        summary = client.post(
            URL, json={"action": "summarize", "pages": pages}, headers=HEADERS
        )
        assert summary.json()["status"] == "summarized"
        invented = client.post(
            URL, json={**ask, "question": "Cita inventada"}, headers=HEADERS
        )
        assert invented.status_code == 502
        assert calls == ["ask", "ask", "summarize", "ask"]
