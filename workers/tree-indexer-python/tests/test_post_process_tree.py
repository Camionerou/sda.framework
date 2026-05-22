import asyncio
import unittest
from unittest.mock import AsyncMock, patch


def _run(coro):
    return asyncio.run(coro)


_VERIFIED_SECTIONS = [
    {"structure": "1", "title": "Introduccion", "physical_index": 1, "valid": True},
    {"structure": "2", "title": "Desarrollo", "physical_index": 3, "valid": True},
]

_RAW_PAGES = [{"page": i, "text": f"Pagina {i} contenido"} for i in range(1, 6)]

_SOURCE_BLOCKS = [
    {"page": 1, "kind": "text", "bbox": [0.0, 0.0, 1.0, 0.5]},
    {"page": 3, "kind": "text", "bbox": [0.0, 0.0, 1.0, 0.5]},
]


def _base_state() -> dict:
    return {
        "document_id": "doc1",
        "document_title": "Informe",
        "document_type": "report",
        "job_id": "j1",
        "run_id": "r1",
        "tenant_id": "t1",
        "raw_pages": _RAW_PAGES,
        "source_blocks": _SOURCE_BLOCKS,
        "verified_sections": list(_VERIFIED_SECTIONS),
        "metrics": {},
    }


class PostProcessTreeTests(unittest.TestCase):
    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    def test_returns_non_empty_tree(self, _mock_event):
        from app.tree_graph.nodes.post_process_tree import post_process_tree

        result = _run(post_process_tree(_base_state()))
        self.assertIn("tree", result)
        self.assertGreater(len(result["tree"]), 0)

    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    def test_each_node_has_confidence(self, _mock_event):
        from app.tree_graph.nodes.post_process_tree import post_process_tree
        from app.tree_graph.helpers import visit_tree

        result = _run(post_process_tree(_base_state()))
        all_nodes = visit_tree(result["tree"])
        for node in all_nodes:
            self.assertIn("confidence", node, f"Node {node.get('title')} missing confidence")
            self.assertIsInstance(node["confidence"], float)
