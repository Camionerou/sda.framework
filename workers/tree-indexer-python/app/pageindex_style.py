from __future__ import annotations

import math
import re
from typing import Any, TypedDict


class LabeledPage(TypedDict):
    page: int
    text: str


class CandidateSection(TypedDict, total=False):
    appear_start: str
    physical_index: int | str | None
    reason: str
    structure: str
    title: str
    valid: bool


class TreeNode(TypedDict, total=False):
    end_index: int
    node_id: str
    nodes: list["TreeNode"]
    start_index: int
    summary: str
    text: str
    title: str


class TreeChunk(TypedDict):
    chunk_index: int
    content: str
    metadata: dict[str, Any]
    node_id: str
    node_path: list[str]
    page_end: int
    page_start: int
    summary: str | None
    token_count: int


def _as_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _as_text_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := _as_text(item))]


def _page_index(item: dict[str, Any]) -> int:
    value = item.get("page_idx")
    return value if isinstance(value, int) and value >= 0 else 0


def _bbox_value(item: dict[str, Any], index: int) -> float:
    bbox = item.get("bbox")
    if not isinstance(bbox, list) or len(bbox) <= index:
        return 0
    value = bbox[index]
    return float(value) if isinstance(value, (int, float)) else 0


def _content_text(item: dict[str, Any]) -> str:
    parts = [
        _as_text(item.get("text")),
        *_as_text_list(item.get("image_caption")),
        *_as_text_list(item.get("image_footnote")),
        *_as_text_list(item.get("table_caption")),
        _as_text(item.get("table_body")),
        *_as_text_list(item.get("table_footnote")),
    ]
    return "\n".join(part for part in parts if part)


def content_list_to_labeled_pages(content_list: Any) -> list[LabeledPage]:
    if not isinstance(content_list, list):
        raise ValueError("MinerU content_list invalido: se esperaba un array.")

    items = [item for item in content_list if isinstance(item, dict)]
    max_page = max((_page_index(item) for item in items), default=0)
    pages: dict[int, list[str]] = {page + 1: [] for page in range(max_page + 1)}

    for item in sorted(items, key=lambda item: (_page_index(item), _bbox_value(item, 1), _bbox_value(item, 0))):
        text = _content_text(item)
        if text:
            pages[_page_index(item) + 1].append(text)

    return [
        {"page": page, "text": "\n\n".join(parts).strip()}
        for page, parts in sorted(pages.items())
    ]


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


def tagged_pages_text(pages: list[LabeledPage]) -> str:
    return "\n\n".join(
        f"<physical_index_{page['page']}>\n{page['text']}\n<physical_index_{page['page']}>"
        for page in pages
    )


def split_pages_for_prompt(pages: list[LabeledPage], max_chars: int) -> list[list[LabeledPage]]:
    safe_max_chars = max_chars if max_chars > 0 else 60_000
    groups: list[list[LabeledPage]] = []
    current: list[LabeledPage] = []
    current_chars = 0

    for page in pages:
        page_chars = len(tagged_pages_text([page]))
        if current and current_chars + page_chars > safe_max_chars:
            groups.append(current)
            current = current[-1:]
            current_chars = len(tagged_pages_text(current))

        current.append(page)
        current_chars += page_chars

    if current:
        groups.append(current)

    return groups


def _physical_index_to_int(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        match = re.search(r"physical_index_(\d+)", value)
        if match:
            return int(match.group(1))
        if value.isdigit():
            return int(value)
    return None


def normalize_candidate_sections(
    sections: list[CandidateSection],
    page_count: int,
) -> list[CandidateSection]:
    normalized: list[CandidateSection] = []
    for section in sections:
        physical_index = _physical_index_to_int(section.get("physical_index"))
        structure = _as_text(section.get("structure")).replace(" ", "")
        title = _as_text(section.get("title"))

        if not structure or not title or physical_index is None:
            continue
        if physical_index < 1 or physical_index > page_count:
            continue

        normalized.append(
            {
                **section,
                "physical_index": physical_index,
                "structure": structure,
                "title": title,
            }
        )
    return normalized


def _add_preface_if_needed(sections: list[CandidateSection]) -> list[CandidateSection]:
    if not sections:
        return sections
    first_index = sections[0].get("physical_index")
    if isinstance(first_index, int) and first_index <= 1:
        return sections
    return [
        {
            "appear_start": "yes",
            "physical_index": 1,
            "structure": "0",
            "title": "Preface",
            "valid": True,
        },
        *sections,
    ]


def _parent_structure(structure: str) -> str | None:
    parts = structure.split(".")
    return ".".join(parts[:-1]) if len(parts) > 1 else None


def _text_for_range(pages: list[LabeledPage], start: int, end: int) -> str:
    return "\n\n".join(
        f"<physical_index_{page['page']}>\n{page['text']}"
        for page in pages
        if start <= page["page"] <= end
    ).strip()


def candidate_sections_to_tree(
    sections: list[CandidateSection],
    pages: list[LabeledPage],
) -> list[TreeNode]:
    normalized = _add_preface_if_needed(normalize_candidate_sections(sections, len(pages)))
    drafts: list[dict[str, Any]] = []

    for index, section in enumerate(normalized):
        current_start = section["physical_index"]
        if not isinstance(current_start, int):
            continue

        next_section = normalized[index + 1] if index + 1 < len(normalized) else None
        if next_section and isinstance(next_section.get("physical_index"), int):
            next_start = int(next_section["physical_index"])
            end_index = next_start - 1 if next_section.get("appear_start") == "yes" else next_start
            end_index = max(current_start, end_index)
        else:
            end_index = len(pages)

        drafts.append(
            {
                "end_index": end_index,
                "nodes": [],
                "start_index": current_start,
                "structure": section["structure"],
                "text": _text_for_range(pages, current_start, end_index),
                "title": section["title"],
            }
        )

    by_structure = {draft["structure"]: draft for draft in drafts}
    roots: list[dict[str, Any]] = []

    for draft in drafts:
        parent = _parent_structure(draft["structure"])
        parent_node = by_structure.get(parent) if parent else None
        if parent_node:
            parent_node["nodes"].append(draft)
        else:
            roots.append(draft)

    counter = 0

    def assign_node_id(draft: dict[str, Any]) -> TreeNode:
        nonlocal counter
        node_id = f"{counter:04d}"
        counter += 1
        node: TreeNode = {
            "end_index": draft["end_index"],
            "node_id": node_id,
            "start_index": draft["start_index"],
            "text": draft["text"],
            "title": draft["title"],
        }
        children = [assign_node_id(child) for child in draft.get("nodes", [])]
        if children:
            node["nodes"] = children
        return node

    return [assign_node_id(root) for root in roots]


def flatten_tree(nodes: list[TreeNode]) -> list[tuple[TreeNode, list[str]]]:
    flattened: list[tuple[TreeNode, list[str]]] = []

    def visit(node: TreeNode, parent_path: list[str]) -> None:
        path = [*parent_path, node["title"]]
        flattened.append((node, path))
        for child in node.get("nodes", []):
            visit(child, path)

    for node in nodes:
        visit(node, [])
    return flattened


def build_chunks_from_tree(nodes: list[TreeNode]) -> list[TreeChunk]:
    chunks: list[TreeChunk] = []
    for index, (node, path) in enumerate(flatten_tree(nodes)):
        content = node.get("text", "").strip() or node["title"]
        chunks.append(
            {
                "chunk_index": index,
                "content": content,
                "metadata": {
                    "page_range": [node["start_index"], node["end_index"]],
                    "source": "pageindex_style_python_tree",
                },
                "node_id": node["node_id"],
                "node_path": path,
                "page_end": node["end_index"],
                "page_start": node["start_index"],
                "summary": node.get("summary"),
                "token_count": estimate_tokens(content),
            }
        )
    return chunks


def remove_node_text(nodes: list[TreeNode]) -> list[TreeNode]:
    clean_nodes: list[TreeNode] = []
    for node in nodes:
        clean_node: TreeNode = {
            "end_index": node["end_index"],
            "node_id": node["node_id"],
            "start_index": node["start_index"],
            "title": node["title"],
        }
        if node.get("summary"):
            clean_node["summary"] = node["summary"]
        if node.get("nodes"):
            clean_node["nodes"] = remove_node_text(node["nodes"])
        clean_nodes.append(clean_node)
    return clean_nodes
