import asyncio
import unittest
from unittest.mock import AsyncMock, patch


def _run(coro):
    return asyncio.run(coro)


_BASE_TREE = [
    {
        "node_id": "0000",
        "title": "Root",
        "start_index": 1,
        "end_index": 5,
        "nodes": [],
        "text": "root text",
        "confidence": 0.8,
    }
]


def _base_state() -> dict:
    return {
        "document_id": "doc1",
        "document_title": "Informe",
        "document_type": "report",
        "job_id": "j1",
        "run_id": "r1",
        "tenant_id": "t1",
        "raw_pages": [{"page": i, "text": f"Page {i}"} for i in range(1, 6)],
        "source_blocks": [],
        "tree": [dict(n) for n in _BASE_TREE],
        "refined_results": [],
        "refinement_iteration": 0,
        "metrics": {"refined_node_count": 0},
    }


class CollectRefinedResultsTests(unittest.TestCase):
    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    def test_applies_subtree_to_node(self, _mock_event):
        from app.tree_graph.nodes.collect_refined_results import collect_refined_results

        subtree = [
            {"node_id": "0001", "title": "Sub A", "start_index": 1, "end_index": 2, "nodes": [], "text": "sub"},
            {"node_id": "0002", "title": "Sub B", "start_index": 3, "end_index": 5, "nodes": [], "text": "sub"},
        ]
        state = _base_state()
        state["refined_results"] = [{"node_id": "0000", "subtree": subtree}]

        result = _run(collect_refined_results(state))
        root = result["tree"][0]
        self.assertEqual(len(root["nodes"]), 2)
        self.assertEqual(result["metrics"]["last_refined_node_count"], 1)

    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    def test_sets_last_refined_node_count_to_zero_when_empty(self, _mock_event):
        from app.tree_graph.nodes.collect_refined_results import collect_refined_results

        result = _run(collect_refined_results(_base_state()))
        self.assertEqual(result["metrics"]["last_refined_node_count"], 0)
        self.assertEqual(result["refined_results"], [])
        self.assertEqual(result["refinement_iteration"], 1)
