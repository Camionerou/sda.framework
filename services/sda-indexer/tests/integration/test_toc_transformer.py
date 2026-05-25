import os
import pytest

from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.structure.toc_transformer import transform_toc
from sda_indexer.pipeline.structure.types import TocNode


pytestmark = pytest.mark.integration


@pytest.fixture
def llm():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        pytest.skip("DEEPSEEK_API_KEY no set")
    return LLMClient(api_key=key, base_url="https://api.deepseek.com/v1")


TOC_RAW_SIMPLE = """\
1. Introduction ............ 3
2. Installation ............ 5
   2.1 Requirements ........ 5
   2.2 Steps ............... 7
3. Configuration ........... 12
"""


async def test_transform_toc_returns_typed_nodes(llm):
    nodes = await transform_toc(
        llm=llm,
        model="deepseek-chat",
        toc_raw=TOC_RAW_SIMPLE,
        doc_summary_short="Generic technical manual",
    )
    assert isinstance(nodes, list)
    assert len(nodes) >= 4
    assert all(isinstance(n, TocNode) for n in nodes)
    titles = [n.title for n in nodes]
    assert any("Introduction" in t for t in titles)
    assert any("Requirements" in t for t in titles)
    intro = next(n for n in nodes if "Introduction" in n.title)
    req = next(n for n in nodes if "Requirements" in n.title)
    assert intro.depth == 1
    assert req.depth == 2
