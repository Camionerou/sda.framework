import os
import pytest

from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.summarizer.contextual_prefix import (
    ContextualResult,
    generate_contextual_prefix_and_summary,
)


pytestmark = pytest.mark.integration


@pytest.fixture
def llm():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        pytest.skip("DEEPSEEK_API_KEY no set")
    return LLMClient(api_key=key, base_url="https://api.deepseek.com/v1")


async def test_returns_prefix_and_summary_in_one_call(llm):
    r = await generate_contextual_prefix_and_summary(
        llm=llm,
        model="deepseek-chat",
        doc_summary_short="Acme Corp 2026 employment contract for senior engineers.",
        chunk_text=(
            "Vacation policy: employees accrue 1.5 days per month, up to a maximum "
            "of 30 days. Unused days roll over annually with a cap of 10 days."
        ),
        prefix_max_tokens=100,
        max_summary_chars=400,
        language="es",
    )
    assert isinstance(r, ContextualResult)
    assert r.prefix
    assert r.summary
    assert r.tokens_in > 0
    assert r.cached_tokens >= 0
