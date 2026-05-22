"""
Integration tests for app.embeddings.embed_texts using httpx.MockTransport.

Only the HTTP transport is replaced; the real parsing, validation, and config
logic all run.  get_supabase_client is lru_cache-d, so we patch it directly.
"""
from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

import httpx

from app.embeddings import embed_texts
from app.http_client import get_supabase_client
from app.llm import TreeLlmPermanentError, TreeLlmTransientError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _run(coro):
    return asyncio.run(coro)


_MINIMAL_ENV = {
    "SDA_EMBEDDING_API_KEY": "test-key",
    "SDA_EMBEDDING_PROVIDER": "openai",
    "SDA_EMBEDDING_BASE_URL": "http://fake.embed.host/v1",
    "SDA_EMBEDDING_MODEL": "test-embed-model",
    "SDA_EMBEDDING_DIMENSIONS": "4",  # tiny for test speed
    "SDA_EMBEDDING_BATCH_SIZE": "96",
}

_FAKE_EMBEDDING = [0.1, 0.2, 0.3, 0.4]  # length matches DIMENSIONS=4


def _ok_response(texts: list[str]) -> dict:
    return {
        "data": [
            {"index": i, "embedding": _FAKE_EMBEDDING}
            for i in range(len(texts))
        ]
    }


class EmbedTextsHttpTests(unittest.TestCase):

    def setUp(self):
        get_supabase_client.cache_clear()
        self._env = patch.dict("os.environ", _MINIMAL_ENV, clear=False)
        self._env.start()

    def tearDown(self):
        self._env.stop()
        get_supabase_client.cache_clear()

    # ------------------------------------------------------------------
    # 200 OK — happy path
    # ------------------------------------------------------------------

    def test_200_returns_embeddings_and_config(self):
        texts = ["alpha", "beta", "gamma"]

        def handler(request):
            return httpx.Response(200, json=_ok_response(texts))

        with patch("app.embeddings.get_supabase_client", return_value=_mock_client(handler)):
            embeddings, config = _run(embed_texts(texts))

        self.assertEqual(len(embeddings), len(texts))
        for emb in embeddings:
            self.assertEqual(emb, _FAKE_EMBEDDING)
        self.assertEqual(config.model, "test-embed-model")
        self.assertEqual(config.provider, "openai")

    # ------------------------------------------------------------------
    # Transient error
    # ------------------------------------------------------------------

    def test_429_raises_transient_error(self):
        def handler(request):
            return httpx.Response(429, json={"error": {"message": "rate limited"}})

        with patch("app.embeddings.get_supabase_client", return_value=_mock_client(handler)):
            with self.assertRaises(TreeLlmTransientError) as ctx:
                _run(embed_texts(["hello"]))

        self.assertEqual(ctx.exception.status_code, 429)

    # ------------------------------------------------------------------
    # Permanent error
    # ------------------------------------------------------------------

    def test_401_raises_permanent_error(self):
        def handler(request):
            return httpx.Response(401, json={"error": {"message": "unauthorized"}})

        with patch("app.embeddings.get_supabase_client", return_value=_mock_client(handler)):
            with self.assertRaises(TreeLlmPermanentError) as ctx:
                _run(embed_texts(["hello"]))

        self.assertEqual(ctx.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
