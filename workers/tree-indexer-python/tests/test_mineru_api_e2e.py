"""
E2E integration smoke test for mineru-api running on srv-ia-01:8765.

Run with:
    cd workers/tree-indexer-python && python3 -m pytest -m integration -v

Skipped automatically in the default `pytest` run (see pyproject.toml addopts).
Skipped at runtime if srv-ia-01 is not reachable via SSH.
"""

import json
import subprocess
import unittest

import pytest


# ---------------------------------------------------------------------------
# SSH + curl helpers
# ---------------------------------------------------------------------------

def _ssh_curl(path: str, timeout: int = 10) -> tuple[int, str]:
    """Run curl on srv-ia-01 via SSH. Returns (returncode, stdout)."""
    result = subprocess.run(
        [
            "ssh",
            "-o", "ConnectTimeout=5",
            "-o", "BatchMode=yes",
            "sistemas@srv-ia-01",
            f"curl -sf -m {timeout} http://127.0.0.1:8765{path}",
        ],
        capture_output=True,
        text=True,
        timeout=timeout + 10,
    )
    return result.returncode, result.stdout


def _mineru_api_available() -> bool:
    """Return True only if srv-ia-01 is SSH-reachable AND mineru-api responds."""
    try:
        rc, _ = _ssh_curl("/docs", timeout=5)
        return rc == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


_AVAILABLE = _mineru_api_available()
_SKIP_REASON = "mineru-api not reachable via SSH to srv-ia-01 (run `ssh sistemas@srv-ia-01` to verify)"


# ---------------------------------------------------------------------------
# Integration tests
# ---------------------------------------------------------------------------

@pytest.mark.integration
@unittest.skipUnless(_AVAILABLE, _SKIP_REASON)
class MineruApiIntegrationTests(unittest.TestCase):
    """Smoke tests: connectivity + OpenAPI contract, no large PDF required."""

    def test_docs_endpoint_responds(self):
        """GET /docs returns non-empty body (Swagger UI HTML)."""
        rc, body = _ssh_curl("/docs")
        self.assertEqual(rc, 0, "/docs curl failed")
        self.assertGreater(len(body), 0, "/docs returned empty body")

    def test_openapi_spec_has_parse_or_file_endpoint(self):
        """GET /openapi.json returns valid JSON spec with a parse/file path."""
        rc, body = _ssh_curl("/openapi.json")
        self.assertEqual(rc, 0, "/openapi.json curl failed")

        spec = json.loads(body)

        # title check — mineru-api should advertise itself
        title = spec.get("info", {}).get("title", "")
        self.assertTrue(
            len(title) > 0,
            "OpenAPI spec has no info.title",
        )

        # at least one endpoint that looks like a parse/file endpoint
        paths = list(spec.get("paths", {}).keys())
        self.assertTrue(
            any("parse" in p.lower() or "file" in p.lower() for p in paths),
            f"No parse/file endpoint found in OpenAPI paths: {paths}",
        )

    def test_openapi_spec_shape(self):
        """OpenAPI spec has the mandatory top-level keys."""
        rc, body = _ssh_curl("/openapi.json")
        self.assertEqual(rc, 0)
        spec = json.loads(body)

        for key in ("openapi", "info", "paths"):
            self.assertIn(key, spec, f"Missing key '{key}' in OpenAPI spec")
