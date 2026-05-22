from __future__ import annotations

from typing import Any

from ..pageindex_style import CandidateSection, LabeledPage, SourceBlock, TreeNode
from .state import NodeTask


def assert_sections(value: Any) -> list[CandidateSection]:
    if not isinstance(value, dict) or not isinstance(value.get("sections"), list):
        raise RuntimeError("El LLM no devolvio una lista de secciones.")
    sections: list[CandidateSection] = []
    for section in value["sections"]:
        if (
            isinstance(section, dict)
            and isinstance(section.get("structure"), str)
            and isinstance(section.get("title"), str)
            and "physical_index" in section
        ):
            sections.append(section)
    return sections


def visit_tree(nodes: list[TreeNode]) -> list[TreeNode]:
    visited: list[TreeNode] = []

    def visit(node: TreeNode) -> None:
        visited.append(node)
        for child in node.get("nodes", []):
            visit(child)

    for node in nodes:
        visit(node)
    return visited


def renumber_tree(nodes: list[TreeNode]) -> list[TreeNode]:
    counter = 0

    def visit(node: TreeNode) -> None:
        nonlocal counter
        node["node_id"] = f"{counter:04d}"
        counter += 1
        for child in node.get("nodes", []):
            visit(child)

    for node in nodes:
        visit(node)
    return nodes


def shift_tree_pages(nodes: list[TreeNode], offset: int) -> list[TreeNode]:
    for node in visit_tree(nodes):
        node["start_index"] += offset
        node["end_index"] += offset
    return nodes


def sub_pages_for_node(node: TreeNode, pages: list[LabeledPage]) -> list[LabeledPage]:
    selected = [page for page in pages if node["start_index"] <= page["page"] <= node["end_index"]]
    return [{"page": index + 1, "text": page["text"]} for index, page in enumerate(selected)]


def node_task(node: TreeNode, path: list[str]) -> NodeTask:
    return {
        "end_index": node["end_index"],
        "node_id": node["node_id"],
        "path": path,
        "start_index": node["start_index"],
        "summary": node.get("summary", ""),
        "text": node.get("text", ""),
        "title": node["title"],
    }


def node_from_task(target: NodeTask) -> TreeNode:
    return {
        "end_index": target["end_index"],
        "node_id": target["node_id"],
        "start_index": target["start_index"],
        "summary": target.get("summary", ""),
        "text": target.get("text", ""),
        "title": target["title"],
    }


def section_identity(section: CandidateSection) -> tuple[str, str, str]:
    return (
        str(section.get("structure", "")).strip(),
        str(section.get("title", "")).strip().casefold(),
        str(section.get("physical_index", "")).strip(),
    )


def section_page(section: CandidateSection) -> int:
    raw_index = section.get("physical_index")
    if isinstance(raw_index, int):
        return raw_index
    digits = "".join(char for char in str(raw_index) if char.isdigit())
    return int(digits) if digits else 0


def structure_sort_key(section: CandidateSection) -> tuple[int, ...]:
    parts = []
    for raw_part in str(section.get("structure", "")).split("."):
        try:
            parts.append(int(raw_part))
        except ValueError:
            parts.append(999)
    return tuple(parts)


def ordered_unique_sections(sections: list[CandidateSection]) -> list[CandidateSection]:
    seen: set[tuple[str, str, str]] = set()
    unique: list[CandidateSection] = []
    for section in sorted(sections, key=lambda item: (section_page(item), structure_sort_key(item))):
        identity = section_identity(section)
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(section)
    return unique


def is_large_leaf(node: TreeNode, *, max_pages: int, max_tokens: int) -> bool:
    from ..pageindex_style import estimate_tokens

    if node.get("nodes"):
        return False
    page_count = node["end_index"] - node["start_index"] + 1
    return page_count > max_pages or estimate_tokens(node.get("text", "")) > max_tokens


def compute_node_confidence(
    *,
    node: TreeNode,
    pages: list[LabeledPage],
    source_blocks: list[SourceBlock],
    verifier_says_valid: bool | None,
) -> float:
    score = 0.0
    if verifier_says_valid is True:
        score += 0.5
    elif verifier_says_valid is None:
        score += 0.25

    start_text = next(
        (page["text"] for page in pages if page["page"] == node["start_index"]),
        "",
    )
    title = node.get("title", "").strip().casefold()
    if title and title in start_text.casefold()[:600]:
        score += 0.3

    block_pages = {
        block["page"]
        for block in source_blocks
        if node["start_index"] <= block["page"] <= node["end_index"]
    }
    range_size = max(node["end_index"] - node["start_index"] + 1, 1)
    overlap = len(block_pages) / range_size
    if overlap >= 0.5:
        score += 0.2
    elif overlap >= 0.2:
        score += 0.1

    return round(min(score, 1.0), 3)
