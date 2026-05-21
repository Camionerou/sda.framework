from __future__ import annotations

import math
import re
from typing import Any, TypedDict


class LabeledPage(TypedDict):
    page: int
    text: str


class SourceBlock(TypedDict):
    bbox: list[float]
    kind: str
    page: int


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
    routing_summary: str
    source_blocks: list[SourceBlock]
    start_index: int
    summary: str
    text: str
    title: str


class TreeChunk(TypedDict):
    chunk_index: int
    content: str
    embedding: list[float] | None
    embedding_model: str | None
    metadata: dict[str, Any]
    node_id: str
    node_path: list[str]
    page_end: int
    page_start: int
    routing_summary: str | None
    summary: str | None
    token_count: int


DocumentType = str


SOURCE_BLOCKS_COORDINATE_SYSTEM = "normalized_page_bbox_top_left_v1"


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


def _as_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def _page_size(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, list) or len(value) < 2:
        return None
    width = _as_number(value[0])
    height = _as_number(value[1])
    if width is None or height is None or width <= 0 or height <= 0:
        return None
    return width, height


def _normalized_bbox(value: Any, page_size: tuple[float, float]) -> list[float] | None:
    if not isinstance(value, list) or len(value) < 4:
        return None

    coordinates = [_as_number(item) for item in value[:4]]
    if any(item is None for item in coordinates):
        return None

    x0, y0, x1, y1 = coordinates
    width, height = page_size
    left = min(x0, x1) / width
    top = min(y0, y1) / height
    right = max(x0, x1) / width
    bottom = max(y0, y1) / height

    normalized = [
        round(min(max(left, 0.0), 1.0), 6),
        round(min(max(top, 0.0), 1.0), 6),
        round(min(max(right, 0.0), 1.0), 6),
        round(min(max(bottom, 0.0), 1.0), 6),
    ]
    if normalized[2] <= normalized[0] or normalized[3] <= normalized[1]:
        return None
    return normalized


def _source_block_kind(value: Any) -> str:
    raw_kind = _as_text(value).casefold().replace("_body", "")
    if not raw_kind:
        return "unknown"
    if "table" in raw_kind:
        return "table"
    if "image" in raw_kind or "figure" in raw_kind:
        return "figure"
    if raw_kind in {"caption", "footer", "header", "list", "paragraph", "text", "title"}:
        return "text"
    return re.sub(r"[^a-z0-9_-]+", "_", raw_kind).strip("_")[:32] or "unknown"


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


def source_blocks_from_mineru_middle(middle_json: Any) -> list[SourceBlock]:
    if not isinstance(middle_json, dict) or not isinstance(middle_json.get("pdf_info"), list):
        return []

    source_blocks: list[SourceBlock] = []
    for page in middle_json["pdf_info"]:
        if not isinstance(page, dict):
            continue

        page_idx = page.get("page_idx")
        page_size = _page_size(page.get("page_size"))
        if not isinstance(page_idx, int) or page_idx < 0 or page_size is None:
            continue

        raw_blocks = page.get("para_blocks")
        if not isinstance(raw_blocks, list):
            raw_blocks = page.get("preproc_blocks")
        if not isinstance(raw_blocks, list):
            continue

        for block in raw_blocks:
            if not isinstance(block, dict):
                continue
            bbox = _normalized_bbox(block.get("bbox"), page_size)
            if not bbox:
                continue
            source_blocks.append(
                {
                    "bbox": bbox,
                    "kind": _source_block_kind(block.get("type")),
                    "page": page_idx + 1,
                }
            )

    return sorted(source_blocks, key=lambda block: (block["page"], block["bbox"][1], block["bbox"][0]))


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


def _source_blocks_for_range(
    source_blocks: list[SourceBlock],
    start: int,
    end: int,
) -> list[SourceBlock]:
    return [block for block in source_blocks if start <= block["page"] <= end]


def _attach_source_blocks(nodes: list[TreeNode], source_blocks: list[SourceBlock]) -> None:
    if not source_blocks:
        return

    def visit(node: TreeNode) -> None:
        node_blocks = _source_blocks_for_range(
            source_blocks,
            node["start_index"],
            node["end_index"],
        )
        if node_blocks:
            node["source_blocks"] = node_blocks
        for child in node.get("nodes", []):
            visit(child)

    for node in nodes:
        visit(node)


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


def _normalize_for_match(text: str) -> str:
    return re.sub(r"\s+", " ", text.casefold()).strip()


def _section_title_starts_page(section: CandidateSection, pages: list[LabeledPage]) -> bool:
    title = _normalize_for_match(_as_text(section.get("title")))
    physical_index = section.get("physical_index")

    if not title or not isinstance(physical_index, int):
        return False

    page = next((candidate for candidate in pages if candidate["page"] == physical_index), None)
    if not page:
        return False

    page_text = _normalize_for_match(page.get("text", ""))
    if not page_text:
        return False

    title_index = page_text.find(title)
    if title_index < 0:
        return False

    prefix = page_text[:title_index].strip()
    if not prefix:
        return True

    prefix_tokens = prefix.split()
    return len(prefix_tokens) <= 6


def _last_nonempty_page(pages: list[LabeledPage]) -> int:
    nonempty = [page["page"] for page in pages if page.get("text", "").strip()]
    return max(nonempty, default=len(pages))


def candidate_sections_to_tree(
    sections: list[CandidateSection],
    pages: list[LabeledPage],
    source_blocks: list[SourceBlock] | None = None,
) -> list[TreeNode]:
    normalized = _add_preface_if_needed(normalize_candidate_sections(sections, len(pages)))
    drafts: list[dict[str, Any]] = []
    last_nonempty_page = _last_nonempty_page(pages)

    for index, section in enumerate(normalized):
        current_start = section["physical_index"]
        if not isinstance(current_start, int):
            continue

        next_section = normalized[index + 1] if index + 1 < len(normalized) else None
        if next_section and isinstance(next_section.get("physical_index"), int):
            next_start = int(next_section["physical_index"])
            next_starts_page = (
                next_section.get("appear_start") == "yes"
                or _section_title_starts_page(next_section, pages)
            )
            end_index = next_start - 1 if next_starts_page else next_start
            end_index = max(current_start, end_index)
        else:
            end_index = last_nonempty_page

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

    tree = [assign_node_id(root) for root in roots]
    _attach_source_blocks(tree, source_blocks or [])
    return tree


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


def build_chunks_from_tree(
    nodes: list[TreeNode],
    *,
    document_type: DocumentType | None = None,
) -> list[TreeChunk]:
    chunks: list[TreeChunk] = []
    for index, (node, path) in enumerate(flatten_tree(nodes)):
        content = node.get("text", "").strip() or node["title"]
        metadata = {
            "page_range": [node["start_index"], node["end_index"]],
            "source": "pageindex_style_python_tree",
        }
        if document_type:
            metadata["document_type"] = document_type
        if node.get("source_blocks"):
            metadata["source_blocks"] = node["source_blocks"]
            metadata["source_blocks_coordinate_system"] = SOURCE_BLOCKS_COORDINATE_SYSTEM

        chunks.append(
            {
                "chunk_index": index,
                "content": content,
                "embedding": None,
                "embedding_model": None,
                "metadata": metadata,
                "node_id": node["node_id"],
                "node_path": path,
                "page_end": node["end_index"],
                "page_start": node["start_index"],
                "routing_summary": node.get("routing_summary"),
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
        if node.get("routing_summary"):
            clean_node["routing_summary"] = node["routing_summary"]
        if node.get("source_blocks"):
            clean_node["source_blocks"] = node["source_blocks"]
        if node.get("nodes"):
            clean_node["nodes"] = remove_node_text(node["nodes"])
        clean_nodes.append(clean_node)
    return clean_nodes
