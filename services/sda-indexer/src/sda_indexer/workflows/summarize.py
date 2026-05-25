"""LangGraph workflow para summarize un nodo. Spec §3.3."""

from typing import TypedDict
import structlog
from langgraph.graph import StateGraph, START, END
from ..db.client import DB
from ..db import tree_nodes, documents
from ..settings.client import SettingsClient
from ..llm.client import LLMClient
from ..llm.retry import with_llm_retry
from ..pipeline.summarizer.summarize import summarize_node, SummaryResult
from ..prompts.loader import load_prompt_files

log = structlog.get_logger()


class State(TypedDict, total=False):
    node_id: str
    document_id: str
    node_text: str
    ancestor_path: str
    doc_title: str
    doc_type: str
    page_count: int | None
    selected_model: str
    max_chars: int
    language: str
    summary: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int


def build_graph(db: DB, settings: SettingsClient, llm: LLMClient, prompts: dict | None = None):
    prompts = prompts or load_prompt_files()

    async def load_node_text(s: State) -> dict:
        n = await tree_nodes.get_node(db.pool, s["node_id"])
        d = await documents.get_document(db.pool, s["document_id"])
        # ancestor_path: chain de titles de root → node
        async with db.pool.acquire() as conn:
            ancestors = await conn.fetch(
                """with recursive chain as (
                     select id, parent_id, title from tree_nodes where id=$1
                     union all
                     select t.id, t.parent_id, t.title from tree_nodes t
                       join chain c on t.id = c.parent_id
                   ) select title from chain""",
                s["node_id"],
            )
        path_titles = list(reversed([r["title"] for r in ancestors]))
        ancestor_path = (
            " > ".join([d["source_path"]] + path_titles[:-1])
            if path_titles
            else d["source_path"]
        )
        return {
            "node_text": n["text"] or "",
            "ancestor_path": ancestor_path,
            "doc_title": d["source_path"],
            "doc_type": d["doc_type"] or "generic",
            "page_count": d["page_count"],
        }

    async def select_model(s: State) -> dict:
        model = await settings.resolve(
            "llm.model.summarize",
            doc_type=s.get("doc_type"),
            document_id=s["document_id"],
        )
        max_chars = await settings.resolve(
            "summarize.max_summary_chars",
            doc_type=s.get("doc_type"),
        )
        language = await settings.resolve(
            "summarize.language",
            document_id=s["document_id"],
        )
        return {"selected_model": model, "max_chars": max_chars, "language": language}

    async def call_llm(s: State) -> dict:
        await tree_nodes.mark_summarizing(db.pool, s["node_id"])
        template = await settings.resolve(
            "prompt.template.summarize",
            doc_type=s.get("doc_type"),
        )
        if isinstance(template, str) and template.startswith("<bootstrapped"):
            template = prompts["summarize"]
        retryable = with_llm_retry(summarize_node, max_attempts=3)
        result: SummaryResult = await retryable(
            llm=llm,
            model=s["selected_model"],
            node_text=s["node_text"],
            ancestor_path=s["ancestor_path"],
            doc_title=s["doc_title"],
            doc_type=s["doc_type"],
            page_count=s["page_count"],
            max_summary_chars=s["max_chars"],
            language=s["language"],
            prompt_template=template,
        )
        return {
            "summary": result.summary,
            "tokens_in": result.tokens_in,
            "tokens_out": result.tokens_out,
            "cached_tokens": result.cached_tokens,
        }

    async def persist(s: State) -> dict:
        await tree_nodes.set_summary(
            db.pool,
            s["node_id"],
            summary=s["summary"],
            model=s["selected_model"],
        )
        log.info(
            "summarize.persisted",
            node_id=s["node_id"],
            tokens_in=s["tokens_in"],
            cached=s["cached_tokens"],
        )
        return {}

    g = StateGraph(State)
    g.add_node("load_node_text", load_node_text)
    g.add_node("select_model", select_model)
    g.add_node("call_llm", call_llm)
    g.add_node("persist", persist)
    g.add_edge(START, "load_node_text")
    g.add_edge("load_node_text", "select_model")
    g.add_edge("select_model", "call_llm")
    g.add_edge("call_llm", "persist")
    g.add_edge("persist", END)
    return g.compile()


async def run_summarize(graph, *, node_id: str, document_id: str) -> dict:
    return await graph.ainvoke({"node_id": node_id, "document_id": document_id})
