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
        "metrics": {"degrade_attempts": 0},
        "repair_attempts": 2,
        "tree_mode": "toc",
        "candidate_sections": [{"structure": "1", "title": "A", "physical_index": 1}],
        "invalid_sections": [{"structure": "2", "title": "B", "physical_index": 2, "valid": False}],
        "verified_sections": [],
    }


class DegradeModeTests(unittest.TestCase):
    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    def test_sets_tree_mode_to_no_toc(self, _mock_event):
        from app.tree_graph.nodes.degrade_mode import degrade_mode

        result = _run(degrade_mode(_base_state()))
        self.assertEqual(result["tree_mode"], "no_toc")

    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    def test_resets_repair_attempts_and_clears_sections(self, _mock_event):
        from app.tree_graph.nodes.degrade_mode import degrade_mode

        result = _run(degrade_mode(_base_state()))
        self.assertEqual(result["repair_attempts"], 0)
        self.assertEqual(result["candidate_sections"], [])
        self.assertEqual(result["invalid_sections"], [])
        self.assertEqual(result["verified_sections"], [])
        self.assertEqual(result["metrics"]["tree_mode"], "no_toc")
        self.assertEqual(result["metrics"]["degrade_attempts"], 1)
