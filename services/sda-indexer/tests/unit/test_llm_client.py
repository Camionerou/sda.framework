import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from sda_indexer.llm.client import LLMClient, LLMResult


@pytest.mark.asyncio
async def test_complete_returns_result():
    fake_completion = MagicMock()
    fake_completion.choices = [MagicMock(message=MagicMock(content="el resumen"))]
    fake_completion.usage = MagicMock(
        prompt_tokens=100, completion_tokens=20,
        prompt_tokens_details=MagicMock(cached_tokens=80),
    )
    fake_completion.model = "deepseek-chat"

    fake_client = MagicMock()
    fake_client.chat.completions.create = AsyncMock(return_value=fake_completion)

    with patch("sda_indexer.llm.client.AsyncOpenAI", return_value=fake_client):
        client = LLMClient(api_key="test", base_url="https://api.deepseek.com/v1")
        result = await client.complete(
            model="deepseek-chat",
            system="you are a summarizer",
            user="text to summarize",
        )

    assert isinstance(result, LLMResult)
    assert result.text == "el resumen"
    assert result.tokens_in == 100
    assert result.tokens_out == 20
    assert result.cached_tokens == 80
    assert result.model == "deepseek-chat"


@pytest.mark.asyncio
async def test_complete_handles_missing_cached_tokens():
    fake_completion = MagicMock()
    fake_completion.choices = [MagicMock(message=MagicMock(content="x"))]
    fake_completion.usage = MagicMock(
        prompt_tokens=10, completion_tokens=2,
        prompt_tokens_details=None,  # provider sin cache info
    )
    fake_completion.model = "m"
    fake_client = MagicMock()
    fake_client.chat.completions.create = AsyncMock(return_value=fake_completion)
    with patch("sda_indexer.llm.client.AsyncOpenAI", return_value=fake_client):
        client = LLMClient(api_key="t", base_url="https://x")
        result = await client.complete(model="m", system="s", user="u")
    assert result.cached_tokens == 0
