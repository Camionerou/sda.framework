import pytest
from unittest.mock import AsyncMock
from sda_indexer.llm.retry import with_llm_retry


@pytest.mark.asyncio
async def test_succeeds_first_try():
    fn = AsyncMock(return_value="ok")
    wrapped = with_llm_retry(fn, max_attempts=3, base_ms=1, max_ms=10)
    result = await wrapped("arg")
    assert result == "ok"
    assert fn.call_count == 1


@pytest.mark.asyncio
async def test_retries_on_transient():
    from openai import APIError
    fn = AsyncMock(side_effect=[
        APIError("transient", request=None, body=None),
        APIError("transient", request=None, body=None),
        "ok",
    ])
    wrapped = with_llm_retry(fn, max_attempts=3, base_ms=1, max_ms=10)
    result = await wrapped()
    assert result == "ok"
    assert fn.call_count == 3


@pytest.mark.asyncio
async def test_gives_up_after_max():
    from openai import APIError
    fn = AsyncMock(side_effect=APIError("persistent", request=None, body=None))
    wrapped = with_llm_retry(fn, max_attempts=2, base_ms=1, max_ms=10)
    with pytest.raises(APIError):
        await wrapped()
    assert fn.call_count == 2
