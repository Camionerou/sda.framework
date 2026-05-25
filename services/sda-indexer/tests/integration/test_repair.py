import os
import pytest

from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.structure.repair import repair_tree, RepairLoopExhausted
from sda_indexer.pipeline.structure.types import TocNode
from sda_indexer.pipeline.structure.validator import validate_tree


pytestmark = pytest.mark.integration


@pytest.fixture
def llm():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        pytest.skip("DEEPSEEK_API_KEY no set")
    return LLMClient(api_key=key, base_url="https://api.deepseek.com/v1")


async def test_repair_fixes_depth_jump(llm):
    bad = [
        TocNode(title="A", depth=1, page_start=1),
        TocNode(title="B", depth=3, page_start=2),
    ]
    fixed, iterations = await repair_tree(
        llm=llm,
        model="deepseek-chat",
        nodes=bad,
        total_pages=20,
        max_depth=6,
        doc_summary_short="Generic doc",
        max_iterations=2,
    )
    result = validate_tree(fixed, total_pages=20, max_depth=6)
    assert result.ok is True
    assert iterations <= 2


async def test_repair_raises_when_unreparable(llm):
    bad = [TocNode(title="", depth=99, page_start=999)]
    with pytest.raises(RepairLoopExhausted):
        await repair_tree(
            llm=llm,
            model="deepseek-chat",
            nodes=bad,
            total_pages=20,
            max_depth=6,
            doc_summary_short="x",
            max_iterations=2,
        )
