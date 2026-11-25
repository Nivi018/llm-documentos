import re
from collections import Counter, defaultdict
from os import getenv
from typing import Protocol
from unicodedata import category, normalize

from .document_query import (
    AskDocument,
    Citation,
    DocumentProvider,
    ProviderName,
    QueryResult,
    SummarizeDocument,
    document_lines,
)
from .ollama_provider import OllamaProvider
from .remote_provider import ConsoleProvider


class ModelProvider(DocumentProvider, Protocol):
    def probe(self) -> str:
        """Verifica el adaptador sin aceptar documentos ni prompts."""
        ...


class StubProvider:
    def probe(self) -> str:
        return "Respuesta simulada; no se llamó a un modelo externo."

    def query(self, query: AskDocument | SummarizeDocument) -> QueryResult:
        lines = document_lines(query.pages)
        if isinstance(query, SummarizeDocument):
            counts = Counter(line.excerpt for line in lines)
            groups: dict[int, list[Citation]] = defaultdict(list)
            for line in lines:
                groups[line.page].append(line)
            citations: list[Citation] = []
            for candidates in groups.values():
                # Prefer sentences and labelled facts to short headings.
                candidates.sort(
                    key=lambda line: (
                        counts[line.excerpt] == 1,
                        bool(
                            {"objetivo", "meta", "total", "responsable"}.intersection(
                                _terms(line.excerpt)
                            )
                        ),
                        ":" in line.excerpt or len(line.excerpt) >= 45,
                    ),
                    reverse=True,
                )
                citations.extend(candidates[:2])
                if len(citations) >= 8:
                    break
            return QueryResult(
                status="summarized" if citations else "not_found",
                citations=citations[:8],
            )

        words = _terms(query.question)
        if words:
            ranked = []
            for line in lines:
                present = set(_terms(line.excerpt))
                if words[0] in present:
                    ranked.append((len(present.intersection(words)), line))
            if ranked:
                match = max(ranked, key=lambda candidate: candidate[0])[1]
                return QueryResult(status="answered", citations=[match])
        return QueryResult(status="not_found", citations=[])


_STOP = {
    "quien",
    "quienes",
    "cual",
    "cuales",
    "cuanto",
    "cuantos",
    "cuando",
    "donde",
    "como",
    "que",
    "el",
    "la",
    "los",
    "las",
    "es",
    "son",
    "sera",
    "fue",
    "del",
    "de",
    "al",
    "a",
    "un",
    "una",
    "y",
    "o",
    "en",
    "se",
    "por",
    "para",
    "su",
    "sus",
    "me",
    "dime",
    "indica",
    "tiene",
    "dice",
    "aparece",
    "hay",
    "sobre",
    "segun",
    "documento",
    "pdf",
    "informacion",
}


def _terms(text: str) -> list[str]:
    plain = "".join(c for c in normalize("NFD", text.casefold()) if category(c) != "Mn")
    return [
        word
        for word in re.findall(r"[a-z0-9]+", plain)
        if len(word) >= 2 and word not in _STOP
    ]


def create_provider(name: str) -> tuple[ProviderName, ModelProvider]:
    if name == "stub":
        return "stub", StubProvider()
    if name == "ollama":
        return "ollama", OllamaProvider()
    if name == "opencode-console":
        key = getenv("OPENCODE_API_KEY", "").strip()
        if not key:
            raise ValueError("Falta OPENCODE_API_KEY para activar OpenCode Console.")
        return "opencode-console", ConsoleProvider(key)
    raise ValueError(
        "LLM_PROVIDER no implementado. Usa 'stub', 'ollama' u 'opencode-console'."
    )
