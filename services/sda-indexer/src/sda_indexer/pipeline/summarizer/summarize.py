"""Summarize node — render prompt + LLM call. Pure function (sin DB)."""

from dataclasses import dataclass
from ...llm.client import LLMClient
from ...prompts.loader import render as render_prompt


@dataclass(frozen=True)
class SummaryResult:
    summary: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int
    model: str
    rendered_user_prompt: str    # útil para audit / debugging


SYSTEM_PROMPT = (
    "You are SDA-Indexer, a document indexing assistant. "
    "Your only job is to write short, factual summaries of document sections "
    "for downstream retrieval. Never invent content not in the input."
)


async def summarize_node(
    *,
    llm: LLMClient,
    model: str,
    node_text: str,
    ancestor_path: str,
    doc_title: str,
    doc_type: str,
    page_count: int | None,
    max_summary_chars: int,
    language: str,
    prompt_template: str,
) -> SummaryResult:
    """Renderiza el prompt con jinja2 y llama al LLM. Devuelve summary + métricas.

    Usa prompts.loader.render para que `{% extends "_base.j2" %}` resuelva
    contra el FileSystemLoader compartido.
    """
    rendered = render_prompt(prompt_template, {
        "task_name": "summarize_node",
        "doc": {"title": doc_title, "doc_type": doc_type, "page_count": page_count or "n/a"},
        "ancestor_path": ancestor_path,
        "max_chars": max_summary_chars,
        "language": language,
        "node_text": node_text,
    })
    result = await llm.complete(
        model=model,
        system=SYSTEM_PROMPT,
        user=rendered,
        temperature=0.2,
        max_tokens=max(64, max_summary_chars // 2),
    )
    return SummaryResult(
        summary=result.text.strip(),
        tokens_in=result.tokens_in,
        tokens_out=result.tokens_out,
        cached_tokens=result.cached_tokens,
        model=result.model,
        rendered_user_prompt=rendered,
    )
