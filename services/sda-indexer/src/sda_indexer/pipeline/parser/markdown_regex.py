"""Markdown parser — regex sobre líneas, skipea code blocks delimitados por ```.
Output: lista FlatHeader que el tree_builder convierte en árbol."""

import re

from ..tree.builder import FlatHeader

HEADER_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


def parse_markdown_to_headers(content: str) -> list[FlatHeader]:
    """Extrae headers + texto siguiente hasta el próximo header.

    Skipea bloques de código delimitados por ``` (no entra a sus contenidos).
    Líneas y start_line son 1-indexed.
    """
    lines = content.splitlines()
    in_code_block = False
    matches: list[tuple[int, int, str]] = []   # (line_idx, level, title)
    for i, line in enumerate(lines):
        if line.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
        m = HEADER_RE.match(line)
        if m:
            level = len(m.group(1))
            title = m.group(2).strip()
            matches.append((i, level, title))

    headers: list[FlatHeader] = []
    for j, (line_idx, level, title) in enumerate(matches):
        text_start = line_idx + 1
        text_end = matches[j + 1][0] if j + 1 < len(matches) else len(lines)
        text = "\n".join(lines[text_start:text_end]).strip()
        headers.append(FlatHeader(
            level=level,
            title=title,
            start_line=line_idx + 1,        # 1-indexed
            text=text,
        ))
    return headers
