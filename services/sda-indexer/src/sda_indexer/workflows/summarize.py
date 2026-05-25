"""LangGraph workflow summarize Wave 1: contextual_prefix + summary combined
+ llm_calls insert (pull-forward Wave 2).
"""

import time
from typing import TypedDict

import structlog
from langgraph.graph import StateGraph, START, END

from ..db.client import DB
from ..db import documents, llm_calls, tree_nodes
from ..llm.client import LLMClient
from ..llm.router import Phase, aroute
from ..pipeline.summarizer.contextual_prefix import (
    ContextualResult, generate_contextual_prefix_and_summary,
)
from ..settings.client import SettingsClient

log = structlog.get_logger()


class State(TypedDict, total=False):
    node_id: str
    document_id: str
    node_text: str
    doc_summary_short: str
    selected_model: str
    temperature: float
    max_chars: int
    language: str
    prefix: str
    summary: str
    text_contextualized: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int
    latency_ms: int


def build_graph(
    db: DB,
    settings: SettingsClient,
    llm: LLMClient,
    checkpointer=None,
):
    async def load_node_and_doc(s: State) -> dict:
        n = await tree_nodes.get_node(db.pool, s["node_id"])
        d = await documents.get_document(db.pool, s["document_id"])
        return {
            "node_text": n["text"] or "",
            "doc_summary_short": d.get("doc_summary_short") or d["source_path"],
        }

    async def select_model(s: State) -> dict:
        cfg = await aroute(Phase.SUMMARIZE, settings=settings, document_id=s["document_id"])
        max_chars = await settings.resolve(
            "summarize.max_summary_chars", document_id=s["document_id"],
        )
        language = await settings.resolve(
            "summarize.language", document_id=s["document_id"],
        )
        return {
            "selected_model": cfg.model,
            "temperature": cfg.temperature,
            "max_chars": max_chars,
            "language": language,
        }

    async def call_llm(s: State) -> dict:
        await tree_nodes.mark_summarizing(db.pool, s["node_id"])
        prefix_max = await settings.resolve(
            "summarize.contextual_chunking.prefix_max_tokens",
            document_id=s["document_id"],
        )
        t0 = time.monotonic()
        success = True
        error_class: str | None = None
        result: ContextualResult | None = None
        try:
            result = await generate_contextual_prefix_and_summary(
                llm=llm,
                model=s["selected_model"],
                doc_summary_short=s["doc_summary_short"],
                chunk_text=s["node_text"],
                prefix_max_tokens=prefix_max,
                max_summary_chars=s["max_chars"],
                language=s["language"],
                temperature=s["temperature"],
            )
        except Exception as e:
            success = False
            error_class = type(e).__name__
            raise
        finally:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            await llm_calls.insert_llm_call(
                db.pool,
                document_id=s["document_id"],
                node_id=s["node_id"],
                phase="summarize",
                model=s["selected_model"],
                prompt_tokens=result.tokens_in if result else 0,
                completion_tokens=result.tokens_out if result else 0,
                cached_tokens=result.cached_tokens if result else 0,
                latency_ms=elapsed_ms,
                success=success,
                error_class=error_class,
            )

        text_contextualized = (
            f"{result.prefix}\n\n{s['node_text']}" if result.prefix else s["node_text"]
        )
        return {
            "prefix": result.prefix,
            "summary": result.summary,
            "text_contextualized": text_contextualized,
            "tokens_in": result.tokens_in,
            "tokens_out": result.tokens_out,
            "cached_tokens": result.cached_tokens,
            "latency_ms": elapsed_ms,
        }

    async def persist(s: State) -> dict:
        # Review-fix (I2): reusar set_summary (Wave 0 ya acepta text_contextualized + summary_model)
        await tree_nodes.set_summary(
            db.pool, s["node_id"],
            summary=s["summary"],
            model=s["selected_model"],
            text_contextualized=s["text_contextualized"],
        )
        log.info(
            "summarize.persisted",
            node_id=s["node_id"],
            tokens_in=s["tokens_in"],
            cached=s["cached_tokens"],
        )
        return {}

    g = StateGraph(State)
    g.add_node("load_node_and_doc", load_node_and_doc)
    g.add_node("select_model", select_model)
    g.add_node("call_llm", call_llm)
    g.add_node("persist", persist)
    g.add_edge(START, "load_node_and_doc")
    g.add_edge("load_node_and_doc", "select_model")
    g.add_edge("select_model", "call_llm")
    g.add_edge("call_llm", "persist")
    g.add_edge("persist", END)
    return g.compile(checkpointer=checkpointer)


async def run_summarize(graph, *, node_id: str, document_id: str) -> dict:
    config = {"configurable": {"thread_id": f"summarize:{node_id}"}}
    return await graph.ainvoke(
        {"node_id": node_id, "document_id": document_id}, config=config,
    )
