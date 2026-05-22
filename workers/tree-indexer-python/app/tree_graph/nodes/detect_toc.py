from __future__ import annotations

import re
from typing import Any

from ...pageindex_style import CandidateSection, LabeledPage
from ..state import TreeState

TOC_LINE = re.compile(r"^(?P<title>.+?)\s*\.{3,}\s*(?P<page>\d+)\s*$")
TOC_DETECTION_RANGE = 0.15  # primeras 15% paginas


def _resolve_logical_to_physical(
    logical: int,
    title: str,
    pages: list[LabeledPage],
) -> int | None:
    """Busca la pagina fisica donde aparece el titulo, comenzando desde la
    pagina cuyo numero impreso coincide con `logical`. Devuelve None si no
    se puede resolver con confianza."""
    needle = title.strip().casefold()[:80]
    if not needle:
        return None

    # 1) Intento directo: la pagina fisica == logical (cubre PDFs sin portada).
    if 1 <= logical <= len(pages):
        text = pages[logical - 1]["text"].casefold()
        if needle in text[:1000]:
            return logical

    # 2) Buscar el titulo a partir del primer match razonable, desde la
    # mitad del documento hacia adelante (saltea ToC).
    skip = max(1, len(pages) // 10)
    for physical in range(skip, len(pages) + 1):
        text = pages[physical - 1]["text"].casefold()
        if needle in text[:1000]:
            return physical

    return None


async def detect_toc(state: TreeState) -> dict[str, Any]:
    pages = state["raw_pages"]  # ver finding 3
    toc_window = pages[: max(5, int(len(pages) * TOC_DETECTION_RANGE))]
    lines = [
        (page["page"], line.strip())
        for page in toc_window
        for line in page["text"].split("\n")
        if line.strip()
    ]
    matches = [(page, TOC_LINE.match(line)) for page, line in lines]
    parsed = [(page, m) for page, m in matches if m]

    if len(parsed) < 4:
        return {
            "tree_mode": "no_toc",
            "metrics": {**state["metrics"], "toc_detected": False},
        }

    sections: list[CandidateSection] = []
    resolved = 0
    for index, (_page, match) in enumerate(parsed):
        logical = int(match.group("page"))
        title = match.group("title").strip()
        physical = _resolve_logical_to_physical(logical, title, pages)
        if physical is None:
            continue
        resolved += 1
        sections.append({
            "structure": str(index + 1),
            "title": title,
            "physical_index": physical,
            "from_toc_heuristic": True,
        })

    resolution_ratio = resolved / len(parsed)
    if resolution_ratio < 0.7 or len(sections) < 4:
        # No confiable: degradar a flujo LLM normal.
        return {
            "tree_mode": "no_toc",
            "metrics": {
                **state["metrics"],
                "toc_detected": True,
                "toc_resolution_ratio": round(resolution_ratio, 3),
                "toc_used": False,
            },
        }

    return {
        "candidate_sections": sections,
        "tree_mode": "toc_heuristic",
        "metrics": {
            **state["metrics"],
            "toc_detected": True,
            "toc_section_count": len(sections),
            "toc_resolution_ratio": round(resolution_ratio, 3),
            "toc_used": True,
        },
    }
