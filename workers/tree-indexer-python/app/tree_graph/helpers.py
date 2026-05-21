from __future__ import annotations

from typing import Any

from ..pageindex_style import CandidateSection, LabeledPage, SourceBlock, TreeNode
from .state import NodeTask


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
