import json
from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import provider
from app.block_summary import fits, make_plan
from app.document_query import QueryPage
from app.main import create_app
from app.ollama_provider import OllamaProvider

FIXTURE = Path(__file__).resolve().parents[2] / "ejemplos/piloto-archivo-largo.pdf"
PLAN = "/api/documents/summary/plan"
BLOCK = "/api/documents/summary/block"
GLOBAL = "/api/documents/summary/global"


def test_splits_long_segment_losslessly_and_keeps_its_number() -> None:
    text = 'ágil "\\\n' * 500
    plan = make_plan([QueryPage(number=7, text=text)])
    assert len(plan.blocks) > 1
    assert all(fits(block.pages) for block in plan.blocks)
    fragments = [page for block in plan.blocks for page in block.pages]
    assert all(page.number == 7 for page in fragments)
    assert "".join(page.text for page in fragments) == text


def test_plan_requires_local_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "stub")
    with TestClient(create_app()) as client:
        for url in (PLAN, BLOCK):
            assert (
                client.post(
                    url, json={"pages": [{"number": 1, "text": "Nota"}]}
                ).status_code
                == 409
            )


def test_summarizes_pdf_in_order_with_original_references(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    call_count = 0

    def reply(request: httpx2.Request) -> httpx2.Response:
        nonlocal call_count
        call_count += 1
        content = json.loads(json.loads(request.content)["messages"][1]["content"])
        assert "solo este bloque" in content["task"]
        last = content["document"][-1]
        excerpt = last["text"].splitlines()[0]
        model = {
            "answer": excerpt,
            "citations": [{"page": last["page"], "excerpt": excerpt}],
        }
        return httpx2.Response(
            200,
            json={
                "done": True,
                "done_reason": "stop",
                "message": {"role": "assistant", "content": json.dumps(model)},
            },
        )

    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setattr(
        provider, "OllamaProvider", lambda: OllamaProvider(httpx2.MockTransport(reply))
    )
    with TestClient(create_app()) as client:
        too_long = {"pages": [{"number": 1, "text": "texto " * 5000}]}
        assert client.post(PLAN, json=too_long).status_code == 413
        assert client.post(BLOCK, json=too_long).status_code == 413
        preview = client.post(
            "/api/documents/pdf/preview",
            content=FIXTURE.read_bytes(),
            headers={"Content-Type": "application/pdf"},
        )
        preview.raise_for_status()
        planned = client.post(PLAN, json=preview.json())
        planned.raise_for_status()
        blocks = planned.json()["blocks"]
        assert call_count == 0
        assert len(blocks) > 1
        assert [page for block in blocks for page in block["pages"]] == preview.json()[
            "pages"
        ]
        results = [client.post(BLOCK, json=block) for block in blocks]
        assert all(result.status_code == 200 for result in results)
        assert results[-1].json()["citations"][0]["page"] == 13
        assert call_count == len(blocks)


@pytest.mark.parametrize("references", [["B1C1", "B2C1"], ["B1C1"], ["B1C1", "B2C9"]])
def test_global_checks_coverage_and_copies_verbatim_citations(
    monkeypatch: pytest.MonkeyPatch, references: list[str]
) -> None:
    calls = 0

    def reply(request: httpx2.Request) -> httpx2.Response:
        nonlocal calls
        calls += 1
        raw = json.loads(request.content)["messages"][1]["content"]
        assert len(raw.encode("utf-8")) <= 2800
        blocks = json.loads(raw)["bloques"]
        assert [item["bloque"] for item in blocks] == [1, 2]
        assert "HZ-47Q-2027" in blocks[1]["citas"][0]["texto"]
        return httpx2.Response(
            200,
            json={
                "done": True,
                "done_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": json.dumps(
                        {
                            "answer": "Actividades iniciales y cierre HZ-47Q-2027. Citas: B1C1, B2C1.",
                            "references": references,
                        }
                    ),
                },
            },
        )

    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setattr(
        provider, "OllamaProvider", lambda: OllamaProvider(httpx2.MockTransport(reply))
    )
    early = "Actividades iniciales de lectura."
    late = "Código de cierre: HZ-47Q-2027."
    pages = [
        {"number": 1, "text": early + " Material listo." * 120},
        {"number": 2, "text": late + " Archivo cerrado." * 120},
    ]
    digests = [
        {
            "answer": "Se realizaron actividades.",
            "citations": [{"page": 1, "excerpt": early}],
        },
        {
            "answer": "Se registró el cierre.",
            "citations": [{"page": 2, "excerpt": late}],
        },
    ]
    with TestClient(create_app()) as client:
        assert (
            client.post(
                GLOBAL, json={"pages": pages, "blocks": digests[:1]}
            ).status_code
            == 422
        )
        assert (
            client.post(
                GLOBAL, json={"pages": pages, "blocks": list(reversed(digests))}
            ).status_code
            == 422
        )
        assert calls == 0
        result = client.post(GLOBAL, json={"pages": pages, "blocks": digests})
        assert calls == 1
        if references == ["B1C1", "B2C1"]:
            assert result.status_code == 200
            assert (
                result.json()["answer"] == "Actividades iniciales y cierre HZ-47Q-2027."
            )
            assert result.json()["citations"] == [
                {"page": 1, "excerpt": early},
                {"page": 2, "excerpt": late},
            ]
        else:
            assert result.status_code == 502
