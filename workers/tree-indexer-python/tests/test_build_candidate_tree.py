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
        "raw_pages": [{"page": i, "text": f"Page {i}"} for i in range(1, 6)],
        "prompt_pages": [{"page": i, "text": f"Page {i}"} for i in range(1, 6)],
        "metrics": {},
        "tree_mode": "toc",
    }


_SECTIONS_RESPONSE = {
    "sections": [
        {"structure": "1", "title": "Introduccion", "physical_index": 1},
        {"structure": "2", "title": "Desarrollo", "physical_index": 3},
    ]
}


class BuildCandidateTreeTests(unittest.TestCase):
    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.build_candidate_tree.call_tree_llm_json",
        new_callable=AsyncMock,
    )
    def test_populates_candidate_sections(self, mock_llm, _mock_event):
        mock_llm.return_value = {
            "json": _SECTIONS_RESPONSE,
            "model": "gpt-4o",
            "provider": "openai",
            "provider_order": ["openai"],
            "service_tier": None,
        }
        from app.tree_graph.nodes.build_candidate_tree import build_candidate_tree

        result = _run(build_candidate_tree(_base_state()))
        self.assertEqual(len(result["candidate_sections"]), 2)
        titles = [s["title"] for s in result["candidate_sections"]]
        self.assertIn("Introduccion", titles)
        self.assertIn("Desarrollo", titles)

    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.build_candidate_tree.call_tree_llm_json",
        new_callable=AsyncMock,
    )
    def test_sets_provider_and_metrics(self, mock_llm, _mock_event):
        mock_llm.return_value = {
            "json": _SECTIONS_RESPONSE,
            "model": "gpt-4o",
            "provider": "openai",
            "provider_order": ["openai"],
            "service_tier": "default",
        }
        from app.tree_graph.nodes.build_candidate_tree import build_candidate_tree

        result = _run(build_candidate_tree(_base_state()))
        self.assertEqual(result["provider"], "openai")
        self.assertEqual(result["metrics"]["llm_provider"], "openai")
        self.assertEqual(result["metrics"]["candidate_section_count"], 2)
