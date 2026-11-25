import json
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import provider
from app.main import create_app
from app.ollama_provider import ENDPOINT, OllamaProvider

URL = "/api/documents/rewrite"
REQUEST = {
    "text": "Nota: se conserva el presupuesto anterior.",
    "instruction": "Usa un tono formal.",
}


def test_rewrite_is_disabled_in_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "stub")
    with TestClient(create_app()) as client:
        assert client.post(URL, json=REQUEST).status_code == 409


@pytest.mark.parametrize(
    ("model_output", "reason", "code"),
    [
        ({"text": "Se conserva el presupuesto anterior."}, "stop", 200),
        ({"text": " "}, "stop", 502),
        ({"text": "Nota\x00"}, "stop", 502),
        ({"text": "Nota incompleta"}, "length", 502),
    ],
)
def test_rewrite_sends_only_selected_text(
    monkeypatch: pytest.MonkeyPatch,
    model_output: dict[str, Any],
    reason: str,
    code: int,
) -> None:
    calls = 0

    def reply(request: httpx2.Request) -> httpx2.Response:
        nonlocal calls
        calls += 1
        assert str(request.url) == ENDPOINT
        payload = json.loads(request.content)
        assert payload["model"] == "qwen3:4b"
        assert json.loads(payload["messages"][1]["content"]) == {
            "fragment": REQUEST["text"],
            "instruction": REQUEST["instruction"],
        }
        return httpx2.Response(
            200,
            json={
                "done": True,
                "done_reason": reason,
                "message": {"role": "assistant", "content": json.dumps(model_output)},
            },
        )

    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setattr(
        provider, "OllamaProvider", lambda: OllamaProvider(httpx2.MockTransport(reply))
    )
    with TestClient(create_app()) as client:
        assert client.post(URL, json={**REQUEST, "pages": []}).status_code == 422
        assert client.post(URL, json={**REQUEST, "text": " "}).status_code == 422
        assert client.post(URL, json={**REQUEST, "text": "ñ" * 1500}).status_code == 413
        assert calls == 0
        response = client.post(URL, json=REQUEST)
    assert calls == 1
    assert response.status_code == code
    if code == 200:
        assert response.json() == model_output
