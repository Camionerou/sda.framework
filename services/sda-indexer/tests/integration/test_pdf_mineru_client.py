"""Integration test del HTTP client. Requiere mineru service corriendo en
MINERU_URL o se skipea. NO mocks (CLAUDE.md)."""

import os

import pytest

from sda_indexer.pipeline.parser.pdf_mineru import (
    MineruClient,
    ParseRequest,
)


pytestmark = pytest.mark.integration


@pytest.fixture
def mineru_url():
    url = os.environ.get("MINERU_URL")
    if not url:
        pytest.skip("MINERU_URL no configurada — skipping integration test")
    return url


@pytest.fixture
def shared_secret():
    s = os.environ.get("MINERU_SHARED_SECRET")
    if not s:
        pytest.skip("MINERU_SHARED_SECRET no configurada")
    return s


async def test_parse_returns_markdown(mineru_url, shared_secret):
    """Smoke test: el client puede comunicarse con el service y obtener markdown.

    Requiere un PDF accesible vía URL pública o signed URL de Supabase.
    """
    test_pdf_url = os.environ.get("TEST_PDF_URL")
    test_pdf_sha = os.environ.get("TEST_PDF_SHA256")
    if not test_pdf_url or not test_pdf_sha:
        pytest.skip("TEST_PDF_URL y TEST_PDF_SHA256 no configurados")

    client = MineruClient(base_url=mineru_url, shared_secret=shared_secret)
    result = await client.parse(ParseRequest(
        doc_id="integration-test",
        signed_url=test_pdf_url,
        expected_sha256=test_pdf_sha,
        force_path=None,
    ))
    assert result.markdown
    assert result.metadata["page_count"] > 0
    assert result.metadata["path_used"] in ("fast", "full")
