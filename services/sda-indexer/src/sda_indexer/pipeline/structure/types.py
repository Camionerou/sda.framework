"""Tipos compartidos entre toc_detector, toc_transformer, index_extractor,
validator y repair. Spec §2.3.

TocNode es la representación intermedia ANTES de persistir a tree_nodes —
sirve para que validator/repair operen sobre estructura plana antes de
convertir a TreeNode jerárquico (que vive en pipeline/tree/builder.py).
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class TocNode:
    """Una entrada del TOC (intermedia, antes de tree_nodes)."""
    title: str
    depth: int               # 1, 2, 3... (1 = top-level)
    page_start: int          # página en el PDF (1-indexed)
    page_end: int | None = None  # se completa en validator/splitter


@dataclass(frozen=True)
class TocDetection:
    """Resultado de toc_detector — qué páginas tienen el TOC raw."""
    has_toc: bool
    toc_pages: list[int]     # páginas (1-indexed) donde se encontró TOC
    toc_raw: str             # texto crudo del TOC, vacío si has_toc=False


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    errors: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)
