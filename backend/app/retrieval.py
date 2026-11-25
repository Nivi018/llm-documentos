import json
import re
from collections import Counter
from collections.abc import Iterator
from typing import TypedDict
from unicodedata import category, normalize

from .document_query import QueryPage

WINDOW = 420
OVERLAP = 80
MAX_HITS = 8
STOP_WORDS = {
    "al",
    "como",
    "con",
    "cual",
    "cuales",
    "cuando",
    "cuanto",
    "cuantos",
    "de",
    "del",
    "dime",
    "donde",
    "el",
    "en",
    "era",
    "es",
    "esta",
    "este",
    "fue",
    "hay",
    "la",
    "las",
    "lo",
    "los",
    "me",
    "para",
    "por",
    "que",
    "quien",
    "se",
    "segun",
    "ser",
    "sobre",
    "son",
    "su",
    "sus",
    "un",
    "una",
    "documento",
    "pdf",
    "texto",
    "indica",
    "aparece",
    "figura",
}


class SearchHit(TypedDict):
    page: int
    text: str


def terms(text: str) -> set[str]:
    plain = "".join(
        char for char in normalize("NFD", text.casefold()) if category(char) != "Mn"
    )
    return {
        word
        for word in re.findall(r"[a-z0-9]+", plain)
        if (len(word) >= 2 or word.isdigit()) and word not in STOP_WORDS
    }


def windows(text: str) -> Iterator[str]:
    offset = 0
    while offset < len(text):
        end = min(len(text), offset + WINDOW)
        if end < len(text):
            boundary = max(
                text.rfind("\n", offset + WINDOW // 2, end),
                text.rfind(" ", offset + WINDOW // 2, end),
            )
            if boundary != -1:
                end = boundary + 1
        snippet = text[offset:end].strip()
        if snippet:
            yield snippet
        if end == len(text):
            return
        offset = end - OVERLAP


def encode_document(task: str, document: list[SearchHit]) -> str:
    return json.dumps({"task": task, "document": document}, ensure_ascii=False)


def retrieve(question: str, pages: list[QueryPage], byte_limit: int) -> list[SearchHit]:
    sought = terms(question)
    if not sought:
        return []

    candidates: list[tuple[SearchHit, set[str]]] = []
    counts: Counter[str] = Counter()
    for page in pages:
        for snippet in windows(page.text):
            matches = terms(snippet) & sought
            if matches:
                candidates.append(({"page": page.number, "text": snippet}, matches))
                counts.update(matches)

    candidates.sort(
        key=lambda candidate: (
            sum(1 / counts[word] for word in sorted(candidate[1])),
            len(candidate[1]),
        ),
        reverse=True,
    )
    hits: list[SearchHit] = []
    for hit, _ in candidates:
        if hit in hits:
            continue
        if len(encode_document(question, [*hits, hit]).encode("utf-8")) <= byte_limit:
            hits.append(hit)
        if len(hits) == MAX_HITS:
            break
    return hits
