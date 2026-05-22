import asyncio
import unittest
from unittest.mock import AsyncMock, patch


def _run(coro):
    return asyncio.run(coro)


_VERIFIED_SECTIONS = [
    {"structure": "1", "title": "Introduccion", "physical_index": 1},
]

_INVALID_SECTIONS = [
    {"structure": "2", "title": "Malo", "physical_index": 3, "valid": False, "reason": "no match"},
]

_REPAIRED_SECTIONS = [
    {"structure": "2", "title": "Desarrollo", "physical_index": 3},
]


def _base_state() -> dict:
    return {
        "document_id": "doc1",
        "document_title": "Informe",
        "document_type": "report",
        "job_id": "j1",
        "run_id": "r1",
        "tenant_id": "t1",
        "prompt_pages": [{"page": i, "text": f"Page {i}"} for i in range(1, 6)],
        "verified_sections": list(_VERIFIED_SECTIONS),
        "invalid_sections": list(_INVALID_SECTIONS),
        "metrics": {"repair_attempts": 0},
        "repair_attempts": 0,
    }


class RepairSectionsTests(unittest.TestCase):
    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.repair_sections.call_tree_llm_json",
        new_callable=AsyncMock,
    )
    def test_updates_candidate_sections_with_repaired(self, mock_llm, _mock_event):
        mock_llm.return_value = {
            "json": {"sections": _REPAIRED_SECTIONS},
            "model": "gpt-4o",
            "provider": "openai",
        }
        from app.tree_graph.nodes.repair_sections import repair_sections

        result = _run(repair_sections(_base_state()))
        titles = [s["title"] for s in result["candidate_sections"]]
        self.assertIn("Introduccion", titles)
        self.assertIn("Desarrollo", titles)
        self.assertEqual(result["invalid_sections"], [])
        self.assertEqual(result["verified_sections"], [])

    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.repair_sections.call_tree_llm_json",
        new_callable=AsyncMock,
    )
    def test_increments_repair_attempts(self, mock_llm, _mock_event):
        mock_llm.return_value = {
            "json": {"sections": _REPAIRED_SECTIONS},
            "model": "gpt-4o",
            "provider": "openai",
        }
        from app.tree_graph.nodes.repair_sections import repair_sections

        state = _base_state()
        state["repair_attempts"] = 1
        state["metrics"]["repair_attempts"] = 1
        result = _run(repair_sections(state))
        self.assertEqual(result["repair_attempts"], 2)
        self.assertEqual(result["metrics"]["repair_attempts"], 2)
