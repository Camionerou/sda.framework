"""
Integration tests for app.llm.call_tree_llm using httpx.MockTransport.

The real code runs end-to-end; only the HTTP transport layer is replaced so
no real network calls are made.  The lru_cache on get_llm_client is cleared in
setUp/tearDown to keep tests isolated.
"""
from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

import httpx
import pytest

from app.http_client import get_llm_client, get_llm_semaphore
from app.llm import (
    TreeLlmJsonParseError,
    TreeLlmPermanentError,
    TreeLlmTransientError,
    call_tree_llm,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_client(handler) -> httpx.AsyncClient:
    """AsyncClient whose transport calls *handler* instead of the network."""
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _run(coro):
    return asyncio.run(coro)


_MINIMAL_ENV = {
    "SDA_TREE_LLM_PROVIDER": "openai",
    "SDA_TREE_LLM_API_KEY": "test-key",
    "SDA_TREE_LLM_MODEL": "test-model",
    "SDA_TREE_SUMMARY_MODEL": "test-model",
    # Point base_url to something that won't accidentally resolve
    "SDA_TREE_LLM_BASE_URL": "http://fake.llm.host/v1",
}

_GOOD_RESPONSE = {
    "choices": [{"message": {"content": "hello world"}, "finish_reason": "stop"}]
}


class CallTreeLlmHttpTests(unittest.TestCase):
    """Tests that exercise HTTP status-code classification and response parsing."""

    def setUp(self):
        get_llm_client.cache_clear()
        get_llm_semaphore.cache_clear()
        self._env = patch.dict("os.environ", _MINIMAL_ENV, clear=False)
        self._env.start()

    def tearDown(self):
        self._env.stop()
        get_llm_client.cache_clear()
        get_llm_semaphore.cache_clear()

    # ------------------------------------------------------------------
    # 200 OK — happy paths
    # ------------------------------------------------------------------

    def test_200_returns_content(self):
        def handler(request):
            return httpx.Response(200, json=_GOOD_RESPONSE)

        with patch("app.llm.get_llm_client", return_value=_mock_client(handler)):
            result = _run(call_tree_llm("prompt", "summary", expect_json=False))

        self.assertEqual(result["content"], "hello world")
        self.assertEqual(result["finish_reason"], "stop")
        self.assertEqual(result["model"], "test-model")
        self.assertEqual(result["provider"], "openai")

    def test_200_expect_json_parses_json_content(self):
        body = {"choices": [{"message": {"content": '{"key": 42}'}, "finish_reason": "stop"}]}

        def handler(request):
            return httpx.Response(200, json=body)

        with patch("app.llm.get_llm_client", return_value=_mock_client(handler)):
            from app.llm import call_tree_llm_json
            result = _run(call_tree_llm_json("prompt", "summary"))

        self.assertEqual(result["json"]["key"], 42)

    def test_200_malformed_json_in_content_raises_json_parse_error(self):
        body = {"choices": [{"message": {"content": "not json at all!!!"}, "finish_reason": "stop"}]}

        def handler(request):
            return httpx.Response(200, json=body)

        with patch("app.llm.get_llm_client", return_value=_mock_client(handler)):
            from app.llm import call_tree_llm_json
            with self.assertRaises(TreeLlmJsonParseError):
                _run(call_tree_llm_json("prompt", "summary"))

    def test_200_empty_content_raises_runtime_error(self):
        body = {"choices": [{"message": {"content": ""}, "finish_reason": "stop"}]}

        def handler(request):
            return httpx.Response(200, json=body)

        with patch("app.llm.get_llm_client", return_value=_mock_client(handler)):
            with self.assertRaises(RuntimeError):
                _run(call_tree_llm("prompt", "summary", expect_json=False))

    # ------------------------------------------------------------------
    # Transient errors (408, 425, 429, 500, 502, 503, 504)
    # ------------------------------------------------------------------

    @pytest.mark.parametrize("status", [408, 425, 429, 500, 502, 503, 504])
    def test_transient_statuses_raise_transient_error(self, status: int = 429):
        """Parametrized via pytest; also runnable standalone as a unit test."""
        self._assert_transient(status)

    def _assert_transient(self, status: int):
        def handler(request):
            return httpx.Response(status, json={"error": {"message": f"err {status}"}})

        with patch("app.llm.get_llm_client", return_value=_mock_client(handler)):
            with self.assertRaises(TreeLlmTransientError) as ctx:
                _run(call_tree_llm("prompt", "summary", expect_json=False))
        self.assertEqual(ctx.exception.status_code, status)

    def test_transient_408(self):
        self._assert_transient(408)

    def test_transient_425(self):
        self._assert_transient(425)

    def test_transient_429(self):
        self._assert_transient(429)

    def test_transient_500(self):
        self._assert_transient(500)

    def test_transient_502(self):
        self._assert_transient(502)

    def test_transient_503(self):
        self._assert_transient(503)

    def test_transient_504(self):
        self._assert_transient(504)

    # ------------------------------------------------------------------
    # Permanent errors (400, 401, 403, 404, 422)
    # ------------------------------------------------------------------

    def _assert_permanent(self, status: int):
        def handler(request):
            return httpx.Response(status, json={"error": {"message": f"err {status}"}})

        with patch("app.llm.get_llm_client", return_value=_mock_client(handler)):
            with self.assertRaises(TreeLlmPermanentError) as ctx:
                _run(call_tree_llm("prompt", "summary", expect_json=False))
        self.assertEqual(ctx.exception.status_code, status)

    def test_permanent_400(self):
        self._assert_permanent(400)

    def test_permanent_401(self):
        self._assert_permanent(401)

    def test_permanent_403(self):
        self._assert_permanent(403)

    def test_permanent_404(self):
        self._assert_permanent(404)

    def test_permanent_422(self):
        self._assert_permanent(422)

    # ------------------------------------------------------------------
    # Timeout — must propagate as-is for RetryPolicy
    # ------------------------------------------------------------------

    def test_timeout_propagates(self):
        def handler(request):
            raise httpx.TimeoutException("timed out", request=request)

        with patch("app.llm.get_llm_client", return_value=_mock_client(handler)):
            with self.assertRaises(httpx.TimeoutException):
                _run(call_tree_llm("prompt", "summary", expect_json=False))

    # ------------------------------------------------------------------
    # Provider: openrouter — must add HTTP-Referer and X-Title headers
    # ------------------------------------------------------------------

    def test_openrouter_provider_adds_required_headers(self):
        captured: dict[str, str] = {}

        def handler(request):
            captured.update(dict(request.headers))
            return httpx.Response(200, json=_GOOD_RESPONSE)

        openrouter_env = {
            **_MINIMAL_ENV,
            "SDA_TREE_LLM_PROVIDER": "openrouter",
        }
        with patch.dict("os.environ", openrouter_env, clear=False):
            with patch("app.llm.get_llm_client", return_value=_mock_client(handler)):
                _run(call_tree_llm("prompt", "summary", expect_json=False))

        self.assertIn("http-referer", captured)
        self.assertIn("x-title", captured)
        self.assertEqual(captured["x-title"], "SDA Framework")

    # ------------------------------------------------------------------
    # Semaphore — get_llm_semaphore is called during call_tree_llm
    # ------------------------------------------------------------------

    def test_semaphore_is_acquired_during_request(self):
        """The real semaphore must be entered (acquired and released) each call."""
        acquired_count = 0
        released_count = 0
        real_sem = get_llm_semaphore()

        class _TrackedSemaphore:
            """Thin wrapper that records acquire/release while delegating."""

            async def __aenter__(self_inner):
                nonlocal acquired_count
                acquired_count += 1
                await real_sem.__aenter__()
                return self_inner

            async def __aexit__(self_inner, *args):
                nonlocal released_count
                released_count += 1
                return await real_sem.__aexit__(*args)

        def handler(request):
            return httpx.Response(200, json=_GOOD_RESPONSE)

        tracked = _TrackedSemaphore()

        with patch("app.llm.get_llm_client", return_value=_mock_client(handler)):
            with patch("app.llm.get_llm_semaphore", return_value=tracked):
                _run(call_tree_llm("prompt", "summary", expect_json=False))

        self.assertEqual(acquired_count, 1)
        self.assertEqual(released_count, 1)


if __name__ == "__main__":
    unittest.main()
