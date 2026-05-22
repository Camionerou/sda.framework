import asyncio
import unittest
from unittest.mock import AsyncMock, patch


def _run(coro):
    return asyncio.run(coro)


def _base_chunks():
    return [
        {
            "chunk_index": 0,
            "node_id": "0000",
            "node_path": ["Cap 1"],
            "content": "Texto del chunk",
            "page_start": 1,
            "page_end": 3,
            "token_count": 50,
            "metadata": {},
            "embedding": None,
            "embedding_model": None,
            "routing_summary": None,
            "summary": None,
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
        "chunks": _base_chunks(),
        "metrics": {},
    }


class EmbedHierarchyTests(unittest.TestCase):
    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.embed_hierarchy.embed_chunks",
        new_callable=AsyncMock,
    )
    def test_returns_chunks_with_embeddings_and_updates_metrics(self, mock_embed, _mock_event):
        from app.embeddings import EmbeddingConfig

        embedded = [{**_base_chunks()[0], "embedding": [0.1, 0.2, 0.3], "embedding_model": "text-embed-3"}]
        config = EmbeddingConfig(
            api_key="k",
            base_url="https://api.openai.com/v1",
            batch_size=10,
            dimensions=3,
            max_input_chars=8192,
            model="text-embed-3",
            provider="openai",
            provider_order=["openai"],
            timeout_seconds=30.0,
        )
        mock_embed.return_value = (embedded, config)
        from app.tree_graph.nodes.embed_hierarchy import embed_hierarchy

        result = _run(embed_hierarchy(_base_state()))
        self.assertEqual(len(result["chunks"]), 1)
        self.assertEqual(result["chunks"][0]["embedding"], [0.1, 0.2, 0.3])
        self.assertEqual(result["metrics"]["embedding_model"], "text-embed-3")
        self.assertEqual(result["metrics"]["embedding_provider"], "openai")
        self.assertEqual(result["metrics"]["embedding_dimension"], 3)
        self.assertEqual(result["metrics"]["embedding_count"], 1)

    @patch("app.tree_graph.events.publish_inngest_event", new_callable=AsyncMock)
    @patch(
        "app.tree_graph.nodes.embed_hierarchy.embed_chunks",
        new_callable=AsyncMock,
    )
    def test_passes_document_type_to_embed_chunks(self, mock_embed, _mock_event):
        from app.embeddings import EmbeddingConfig

        config = EmbeddingConfig(
            api_key="k",
            base_url="https://api.openai.com/v1",
            batch_size=10,
            dimensions=1536,
            max_input_chars=8192,
            model="text-embed-3",
            provider="openai",
            provider_order=["openai"],
            timeout_seconds=30.0,
        )
        embedded = [{**_base_chunks()[0], "embedding": [0.0], "embedding_model": "text-embed-3"}]
        mock_embed.return_value = (embedded, config)
        from app.tree_graph.nodes.embed_hierarchy import embed_hierarchy

        _run(embed_hierarchy(_base_state()))
        _call_kwargs = mock_embed.call_args
        self.assertEqual(_call_kwargs.kwargs.get("document_type"), "report")
