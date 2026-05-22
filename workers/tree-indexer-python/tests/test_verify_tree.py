import asyncio
import unittest
from unittest.mock import AsyncMock, patch


def _run(coro):
    return asyncio.run(coro)


_CANDIDATE_SECTIONS = [
    {"structure": "1", "title": "Introduccion", "physical_index": 1},
    {"structure": "2", "title": "Desarrollo", "physical_index": 3},
    {"structure": "3", "title": "Conclusiones", "physical_index": 5},
]


def _base_state() -> dict:
    return {
        "document_id": "doc1",
        "document_title": "Informe",
        "document_type": "report",
        "job_id": "j1",
        "run_id": "r1",
        "tenant_id": "t1",
        "prompt_pages": [{"page": i, "text": f"Page {i}"} for i in range(1, 7)],
        "candidate_sections": list(_CANDIDATE_SECTIONS),
        "metrics": {},
    }


class VerifyTreeTests(unittest.TestCase):
    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.verify_tree.call_tree_llm_json",
        new_callable=AsyncMock,
    )
    def test_all_valid_sections(self, mock_llm, _mock_event):
        # LLM returns all sections as valid=True
        valid_sections = [
            {**s, "valid": True} for s in _CANDIDATE_SECTIONS
        ]
        mock_llm.return_value = {
            "json": {"sections": valid_sections},
            "model": "gpt-4o",
            "provider": "openai",
        }
        from app.tree_graph.nodes.verify_tree import verify_tree

        result = _run(verify_tree(_base_state()))
        self.assertEqual(len(result["verified_sections"]), 3)
        self.assertEqual(len(result["invalid_sections"]), 0)
        self.assertAlmostEqual(result["metrics"]["verification_accuracy"], 1.0)

    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.verify_tree.call_tree_llm_json",
        new_callable=AsyncMock,
    )
    def test_one_invalid_section(self, mock_llm, _mock_event):
        # LLM returns first two valid, last one invalid
        checked = [
            {**_CANDIDATE_SECTIONS[0], "valid": True},
            {**_CANDIDATE_SECTIONS[1], "valid": True},
            {**_CANDIDATE_SECTIONS[2], "valid": False, "reason": "bad"},
        ]
        mock_llm.return_value = {
            "json": {"sections": checked},
            "model": "gpt-4o",
            "provider": "openai",
        }
        from app.tree_graph.nodes.verify_tree import verify_tree

        result = _run(verify_tree(_base_state()))
        self.assertEqual(len(result["verified_sections"]), 2)
        self.assertEqual(len(result["invalid_sections"]), 1)
        self.assertAlmostEqual(result["metrics"]["verification_accuracy"], 2 / 3)
