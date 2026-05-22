import asyncio
import unittest
from unittest.mock import AsyncMock, patch


def _run(coro):
    return asyncio.run(coro)


def _base_tree():
    return [
        {
            "node_id": "0000",
            "title": "Cap 1",
            "start_index": 1,
            "end_index": 3,
            "nodes": [
                {"node_id": "0001", "title": "Sub", "start_index": 1, "end_index": 2, "nodes": []},
            ],
        },
    ]


def _base_state() -> dict:
    return {
        "document_id": "doc1",
        "document_title": "Informe",
        "document_type": "report",
        "job_id": "j1",
        "run_id": "r1",
        "tenant_id": "t1",
        "tree": _base_tree(),
        "summary_results": [
            {"node_id": "0000", "text": "Resumen cap 1"},
            {"node_id": "0001", "text": "Resumen sub"},
        ],
        "summary_cache_hits": 1,
        "summary_cache_misses": 1,
        "metrics": {},
    }


class CollectSummariesTests(unittest.TestCase):
    @patch(
        "app.tree_graph.nodes.collect_summaries.call_tree_llm_text",
        new_callable=AsyncMock,
    )
    def test_applies_summary_to_tree_nodes(self, mock_llm):
        mock_llm.return_value = {"content": "Resumen global del documento."}
        from app.tree_graph.nodes.collect_summaries import collect_summaries
        from app.tree_graph.helpers import visit_tree

        state = _base_state()
        result = _run(collect_summaries(state))
        all_nodes = visit_tree(state["tree"])
        summaries = {n["node_id"]: n.get("summary") for n in all_nodes}
        self.assertEqual(summaries["0000"], "Resumen cap 1")
        self.assertEqual(summaries["0001"], "Resumen sub")

    @patch(
        "app.tree_graph.nodes.collect_summaries.call_tree_llm_text",
        new_callable=AsyncMock,
    )
    def test_emits_doc_summary_and_cache_metrics(self, mock_llm):
        mock_llm.return_value = {"content": "  Doc summary.  "}
        from app.tree_graph.nodes.collect_summaries import collect_summaries

        result = _run(collect_summaries(_base_state()))
        self.assertEqual(result["doc_summary"], "Doc summary.")
        self.assertEqual(result["metrics"]["summary_cache_hits"], 1)
        self.assertEqual(result["metrics"]["summary_cache_misses"], 1)
        self.assertEqual(result["metrics"]["summary_node_count"], 2)
