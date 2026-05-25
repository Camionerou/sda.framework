"""Integration test del detector. Usa LLM real — skipea si DEEPSEEK_API_KEY no set.
NO mocks (CLAUDE.md)."""

import os
import pytest

from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.structure.toc_detector import detect_toc
from sda_indexer.pipeline.structure.types import TocDetection


pytestmark = pytest.mark.integration


@pytest.fixture
def llm():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        pytest.skip("DEEPSEEK_API_KEY no set")
    return LLMClient(api_key=key, base_url="https://api.deepseek.com/v1")


SAMPLE_WITH_TOC = """\
## Page 1
Acme Corp Manual

## Page 2
Table of Contents

1. Introduction .................. 3
2. Installation .................. 5
3. Configuration ................. 8
4. Troubleshooting ............... 12

## Page 3
1. Introduction
Welcome to Acme.
"""


SAMPLE_NO_TOC = """\
## Page 1
Random scan output without structure.
Lorem ipsum dolor sit amet.

## Page 2
More random text without any TOC markers.
"""


async def test_detect_toc_returns_pages_when_present(llm):
    result = await detect_toc(
        llm=llm,
        model="deepseek-chat",
        markdown=SAMPLE_WITH_TOC,
        doc_summary_short="Acme Corp installation manual",
        max_scan_pages=20,
    )
    assert isinstance(result, TocDetection)
    assert result.has_toc is True
    assert 2 in result.toc_pages
    assert "Introduction" in result.toc_raw


async def test_detect_toc_returns_empty_when_absent(llm):
    result = await detect_toc(
        llm=llm,
        model="deepseek-chat",
        markdown=SAMPLE_NO_TOC,
        doc_summary_short="Scanned legal document",
        max_scan_pages=20,
    )
    assert isinstance(result, TocDetection)
    assert result.has_toc is False
    assert result.toc_pages == []
