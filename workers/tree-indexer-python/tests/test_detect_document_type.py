import asyncio
import unittest
from unittest.mock import AsyncMock, patch


def _run(coro):
    return asyncio.run(coro)


def _base_state() -> dict:
    return {
        "document_id": "doc1",
        "document_title": "Informe Anual",
        "document_type": "other",
        "job_id": "j1",
        "run_id": "r1",
        "tenant_id": "t1",
        "raw_pages": [{"page": 1, "text": "hola"}],
        "prompt_pages": [{"page": 1, "text": "hola"}],
        "metrics": {},
    }


class DetectDocumentTypeTests(unittest.TestCase):
    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.detect_document_type.call_tree_llm_json",
        new_callable=AsyncMock,
    )
    def test_assigns_document_type_from_llm(self, mock_llm, _mock_event):
        mock_llm.return_value = {
            "json": {"type": "report"},
            "model": "gpt-4o",
            "provider": "openai",
        }
        from app.tree_graph.nodes.detect_document_type import detect_document_type

        result = _run(detect_document_type(_base_state()))
        self.assertEqual(result["document_type"], "report")
        self.assertEqual(result["metrics"]["document_type"], "report")
        self.assertEqual(result["metrics"]["document_type_model"], "gpt-4o")
        self.assertEqual(result["metrics"]["document_type_provider"], "openai")

    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.detect_document_type.call_tree_llm_json",
        new_callable=AsyncMock,
    )
    def test_falls_back_to_other_for_unknown_type(self, mock_llm, _mock_event):
        mock_llm.return_value = {
            "json": {"type": "unicorn_document"},
            "model": "gpt-4o",
            "provider": "openai",
        }
        from app.tree_graph.nodes.detect_document_type import detect_document_type

        result = _run(detect_document_type(_base_state()))
        self.assertEqual(result["document_type"], "other")
