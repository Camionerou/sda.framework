import os
import pytest

from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.structure.index_extractor import extract_index
from sda_indexer.pipeline.structure.types import TocNode


pytestmark = pytest.mark.integration


@pytest.fixture
def llm():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        pytest.skip("DEEPSEEK_API_KEY no set")
    return LLMClient(api_key=key, base_url="https://api.deepseek.com/v1")


SAMPLE_NO_TOC = """\
## Page 1
Acme Whitepaper 2026

## Page 2
1. Introduction
This whitepaper introduces Acme's vision.

## Page 3
1.1 Background
Acme was founded in 2020.

## Page 4
2. Architecture
The system uses microservices.

## Page 5
2.1 Data flow
Events flow through Kafka.
"""


async def test_extract_index_infers_structure_when_no_toc(llm):
    nodes = await extract_index(
        llm=llm,
        model="deepseek-chat",
        markdown=SAMPLE_NO_TOC,
        doc_summary_short="Acme 2026 whitepaper",
        chunk_size_pages=3,
    )
    assert isinstance(nodes, list)
    assert all(isinstance(n, TocNode) for n in nodes)
    titles = [n.title for n in nodes]
    assert any("Introduction" in t for t in titles)
    assert any("Architecture" in t for t in titles)
