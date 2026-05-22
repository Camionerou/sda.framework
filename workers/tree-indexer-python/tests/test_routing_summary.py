import asyncio
import unittest
from unittest.mock import AsyncMock, patch


def _run(coro):
    return asyncio.run(coro)


def _base_state_routing() -> dict:
    return {
        "document_id": "doc1",
        "document_title": "Informe",
        "document_type": "report",
        "job_id": "j1",
        "run_id": "r1",
        "tenant_id": "t1",
        "routing_target": {
            "node_id": "0001",
            "title": "Introduccion",
            "start_index": 1,
            "end_index": 3,
            "text": "Texto del nodo",
            "summary": "Resumen previo",
            "path": ["Introduccion"],
        },
        "metrics": {},
    }


def _tree_with_routing() -> list:
    return [
        {
            "node_id": "0000",
            "title": "Cap 1",
            "start_index": 1,
            "end_index": 5,
            "nodes": [],
            "text": "texto",
            "summary": "resumen cap",
            "routing_summary": "Para navegacion en Cap 1.",
            "confidence": 0.8,
        }
    ]


class SummarizeOneRoutingTests(unittest.TestCase):
    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.routing_summary.call_tree_llm_text",
        new_callable=AsyncMock,
    )
    def test_returns_routing_summary_result_with_node_id(self, mock_llm, _mock_event):
        mock_llm.return_value = {"content": "  Este nodo trata de la introduccion.  "}
        from app.tree_graph.nodes.routing_summary import summarize_one_routing

        result = _run(summarize_one_routing(_base_state_routing()))
        self.assertIn("routing_summary_results", result)
        self.assertEqual(len(result["routing_summary_results"]), 1)
        entry = result["routing_summary_results"][0]
        self.assertEqual(entry["node_id"], "0001")
        self.assertEqual(entry["text"], "Este nodo trata de la introduccion.")


class CollectRoutingSummariesTests(unittest.TestCase):
    def test_applies_routing_summary_and_builds_chunks(self):
        from app.tree_graph.nodes.routing_summary import collect_routing_summaries

        tree = _tree_with_routing()
        state = {
            "document_id": "doc1",
            "document_title": "Informe",
            "document_type": "report",
            "job_id": "j1",
            "run_id": "r1",
            "tenant_id": "t1",
            "tree": tree,
            "routing_summary_results": [
                {"node_id": "0000", "text": "Nav summary for cap 1"},
            ],
            "metrics": {},
        }
        result = collect_routing_summaries(state)
        self.assertIn("chunks", result)
        self.assertGreater(len(result["chunks"]), 0)
        self.assertEqual(result["metrics"]["chunk_count"], len(result["chunks"]))

    def test_computes_confidence_mean_and_min(self):
        from app.tree_graph.nodes.routing_summary import collect_routing_summaries

        tree = [
            {
                "node_id": "0000",
                "title": "A",
                "start_index": 1,
                "end_index": 2,
                "nodes": [],
                "text": "t",
                "confidence": 0.9,
            },
            {
                "node_id": "0001",
                "title": "B",
                "start_index": 3,
                "end_index": 4,
                "nodes": [],
                "text": "t",
                "confidence": 0.7,
            },
        ]
        state = {
            "document_id": "doc1",
            "document_type": "report",
            "tree": tree,
            "routing_summary_results": [],
            "metrics": {},
        }
        result = collect_routing_summaries(state)
        self.assertAlmostEqual(result["metrics"]["confidence_mean"], 0.8, places=2)
        self.assertAlmostEqual(result["metrics"]["confidence_min"], 0.7, places=2)
