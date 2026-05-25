"""Validator de [TocNode]. Pure function, sin IO ni LLM.

Checks (de menos a más severo):
1. Lista no vacía.
2. Todos los titles tienen contenido tras strip().
3. Todos los page_start están en [1, total_pages].
4. page_start monótono creciente (orden de aparición).
5. depth jumps de >1 (depth 1 → depth 3 sin pasar por 2) son sospechosos.
6. depth no excede max_depth.

Devuelve ValidationResult con errors (bloqueantes) y suggestions (hints
para repair). Spec §3 PageIndex T+ validation.
"""

from .types import TocNode, ValidationResult


def validate_tree(
    nodes: list[TocNode], *, total_pages: int, max_depth: int = 6,
) -> ValidationResult:
    errors: list[str] = []
    suggestions: list[str] = []

    if not nodes:
        return ValidationResult(
            ok=False,
            errors=["tree is empty — no headings extracted"],
            suggestions=["consider falling back to index_extractor or marking doc as unstructured"],
        )

    prev_page = 0
    prev_depth = 0

    for i, n in enumerate(nodes):
        if not n.title.strip():
            errors.append(f"node[{i}] has empty title")

        if n.page_start < 1 or n.page_start > total_pages:
            errors.append(
                f"node[{i}] '{n.title[:40]}' page_start {n.page_start} "
                f"out of range [1, {total_pages}]"
            )

        if n.page_start < prev_page:
            errors.append(
                f"node[{i}] '{n.title[:40]}' page_start {n.page_start} "
                f"out of order (previous was {prev_page})"
            )

        if n.depth > max_depth:
            errors.append(
                f"node[{i}] '{n.title[:40]}' depth {n.depth} exceeds max_depth {max_depth}"
            )

        if prev_depth > 0 and n.depth > prev_depth + 1:
            errors.append(
                f"node[{i}] '{n.title[:40]}' depth jump from {prev_depth} to {n.depth} "
                f"— missing intermediate level"
            )
            suggestions.append(
                f"reduce node[{i}] depth to {prev_depth + 1} or insert intermediate parent"
            )

        prev_page = n.page_start
        prev_depth = n.depth

    return ValidationResult(ok=not errors, errors=errors, suggestions=suggestions)
