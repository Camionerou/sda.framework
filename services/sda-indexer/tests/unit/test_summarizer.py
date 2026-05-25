import pytest
from unittest.mock import AsyncMock
from sda_indexer.pipeline.summarizer.summarize import summarize_node
from sda_indexer.llm.client import LLMResult


@pytest.mark.asyncio
async def test_summarize_returns_summary():
    llm = AsyncMock()
    llm.complete = AsyncMock(return_value=LLMResult(
        text="Resumen breve.", tokens_in=100, tokens_out=10,
        cached_tokens=80, model="deepseek-chat",
    ))
    result = await summarize_node(
        llm=llm,
        model="deepseek-chat",
        node_text="texto del nodo",
        ancestor_path="Doc > Cap 1",
        doc_title="Doc",
        doc_type="generic",
        page_count=10,
        max_summary_chars=280,
        language="es",
        prompt_template="""You are SDA. Task: {{ task_name }}
Context: {{ doc.title }} ({{ doc.doc_type }}, {{ doc.page_count }} pages)
Path: {{ ancestor_path }}
Max chars: {{ max_chars }}
Lang: {{ language }}
Input:
{{ node_text }}""",
    )
    assert result.summary == "Resumen breve."
    assert result.tokens_in == 100
    assert result.cached_tokens == 80
    # Verificar que el prompt llegó renderizado
    call = llm.complete.call_args
    assert "Doc" in call.kwargs["user"]
    assert "Cap 1" in call.kwargs["user"]
    assert "texto del nodo" in call.kwargs["user"]
