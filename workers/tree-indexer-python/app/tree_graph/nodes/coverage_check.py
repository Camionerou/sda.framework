from __future__ import annotations

from typing import Any

from ...pageindex_style import TreeNode, flatten_tree
from ..helpers import renumber_tree
from ..state import TreeState


async def coverage_check(state: TreeState) -> dict[str, Any]:
    tree = state["tree"]
    pages = state["raw_pages"]
    total_pages = max((page["page"] for page in pages), default=0)
    covered: set[int] = set()
    for node, _path in flatten_tree(tree):
        for page in range(node["start_index"], node["end_index"] + 1):
            covered.add(page)
    expected = set(range(1, total_pages + 1))
    missing = sorted(expected - covered)

    coverage_ratio = (len(covered) / total_pages) if total_pages else 1.0
    metrics = {
        **state["metrics"],
        "coverage_ratio": round(coverage_ratio, 4),
        "missing_page_count": len(missing),
    }

    if not missing or coverage_ratio >= 0.95:
        return {"tree": tree, "metrics": metrics}

    # Agrupar paginas faltantes en rangos contiguos -> nodos huerfanos.
    orphan_nodes: list[TreeNode] = []
    if missing:
        groups: list[list[int]] = [[missing[0]]]
        for page in missing[1:]:
            if page == groups[-1][-1] + 1:
                groups[-1].append(page)
            else:
                groups.append([page])
        for index, group in enumerate(groups):
            orphan_nodes.append({
                "node_id": f"orphan-{index:03d}",
                "title": f"Paginas no clasificadas {group[0]}-{group[-1]}",
                "start_index": group[0],
                "end_index": group[-1],
                "summary": "",
                "confidence": 0.0,
                "nodes": [],
            })

    updated_tree = [*tree, *orphan_nodes]
    metrics["coverage_gap"] = True
    metrics["orphan_node_count"] = len(orphan_nodes)
    return {"tree": renumber_tree(updated_tree), "metrics": metrics}
