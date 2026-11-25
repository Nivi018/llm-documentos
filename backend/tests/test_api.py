import pytest
from fastapi.testclient import TestClient

from app.main import create_app


def test_health(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    with TestClient(create_app()) as client:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


def test_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "stub")
    with TestClient(create_app()) as client:
        response = client.get("/api/provider/probe")
        assert response.status_code == 200
        assert response.json() == {
            "provider": "stub",
            "message": "Respuesta simulada; no se llamó a un modelo externo.",
        }


def test_unknown_provider_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "unknown")
    with pytest.raises(ValueError, match="LLM_PROVIDER"):
        create_app()
