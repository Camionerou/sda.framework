import asyncio
import unittest
from unittest.mock import AsyncMock, patch


def _run(coro):
    return asyncio.run(coro)


def _base_state() -> dict:
    return {
        "document_id": "doc1",
        "document_title": "Informe",
        "document_type": "report",
        "job_id": "j1",
        "run_id": "r1",
        "tenant_id": "t1",
        "summary_target": {
            "node_id": "0001",
            "title": "Introduccion",
            "start_index": 1,
            "end_index": 3,
            "text": "Texto del nodo",
            "summary": "",
            "path": ["Introduccion"],
        },
        "metrics": {},
    }


class SummarizeOneNodeTests(unittest.TestCase):
    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch("app.tree_graph.nodes.summarize_node.set_cached", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.summarize_node.call_tree_llm_text",
        new_callable=AsyncMock,
    )
    @patch(
        "app.tree_graph.nodes.summarize_node.get_cached",
        new_callable=AsyncMock,
        return_value=None,
    )
    def test_cache_miss_calls_llm_and_increments_misses(
        self, _mock_get, mock_llm, mock_set, _mock_event
    ):
        mock_llm.return_value = {"content": "  Este es el resumen generado.  "}
        from app.tree_graph.nodes.summarize_node import summarize_one_node

        result = _run(summarize_one_node(_base_state()))
        self.assertEqual(result["summary_results"][0]["node_id"], "0001")
        self.assertEqual(result["summary_results"][0]["text"], "Este es el resumen generado.")
        self.assertEqual(result["summary_cache_misses"], 1)
        self.assertNotIn("summary_cache_hits", result)
        mock_set.assert_awaited_once()

    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.summarize_node.get_cached",
        new_callable=AsyncMock,
        return_value="Resumen cacheado.",
    )
    def test_cache_hit_returns_cached_and_increments_hits(self, _mock_get, _mock_event):
        from app.tree_graph.nodes.summarize_node import summarize_one_node

        result = _run(summarize_one_node(_base_state()))
        self.assertEqual(result["summary_results"][0]["text"], "Resumen cacheado.")
        self.assertEqual(result["summary_cache_hits"], 1)
        self.assertNotIn("summary_cache_misses", result)
