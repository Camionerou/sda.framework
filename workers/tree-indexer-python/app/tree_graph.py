from __future__ import annotations

import asyncio
import os
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from .llm import call_tree_llm_json, call_tree_llm_text
from .pageindex_style import (
    CandidateSection,
    LabeledPage,
    SOURCE_BLOCKS_COORDINATE_SYSTEM,
    SourceBlock,
    TreeChunk,
    TreeNode,
    build_chunks_from_tree,
    candidate_sections_to_tree,
    flatten_tree,
    remove_node_text,
    split_pages_for_prompt,
    tagged_pages_text,
)
from .prompts import candidate_prompt, doc_summary_prompt, summary_prompt, verification_prompt
from .versions import TREE_INDEXER_PYTHON_VERSION

TREE_INDEXER_VERSION = TREE_INDEXER_PYTHON_VERSION


class TreeState(TypedDict):
    candidate_sections: list[CandidateSection]
    chunks: list[TreeChunk]
    doc_summary: str
    document_title: str
    metrics: dict[str, Any]
    pages: list[LabeledPage]
    provider: str
    source_blocks: list[SourceBlock]
    tree: list[TreeNode]
    verified_sections: list[CandidateSection]
    version: str


def _max_prompt_chars() -> int:
    try:
        value = int(os.getenv("SDA_TREE_MAX_PROMPT_CHARS", "60000"))
    except ValueError:
        return 60_000
    return value if value > 0 else 60_000


def _summary_concurrency() -> int:
    try:
        value = int(os.getenv("SDA_TREE_SUMMARY_CONCURRENCY", "3"))
    except ValueError:
        return 3
    return value if value > 0 else 3


def _assert_sections(value: Any) -> list[CandidateSection]:
    if not isinstance(value, dict) or not isinstance(value.get("sections"), list):
        raise RuntimeError("El LLM no devolvio una lista de secciones.")
    sections: list[CandidateSection] = []
    for section in value["sections"]:
        if (
            isinstance(section, dict)
            and isinstance(section.get("structure"), str)
            and isinstance(section.get("title"), str)
            and "physical_index" in section
        ):
            sections.append(section)
    return sections


async def build_candidate_tree(state: TreeState) -> dict[str, Any]:
    groups = split_pages_for_prompt(state["pages"], _max_prompt_chars())
    sections: list[CandidateSection] = []
    model: str | None = None
    provider: str | None = None
    provider_order: list[str] = []
    service_tier: str | None = None

    for group in groups:
        response = await call_tree_llm_json(
            candidate_prompt(
                state["document_title"],
                tagged_pages_text(group),
                sections if sections else None,
            ),
            "structure",
        )
        sections.extend(_assert_sections(response["json"]))
        model = response["model"]
        provider = response["provider"]
        provider_order = response.get("provider_order") or []
        service_tier = response.get("service_tier")

    if not sections:
        raise RuntimeError("Tree LLM no encontro secciones para construir el arbol.")

    metrics = {
        **state["metrics"],
        "candidate_section_count": len(sections),
        "llm_model": model,
        "llm_provider": provider,
        "llm_provider_order": provider_order,
        "llm_service_tier": service_tier,
    }
    return {
        "candidate_sections": sections,
        "metrics": metrics,
        "provider": provider or "",
        "version": TREE_INDEXER_VERSION,
    }


async def verify_tree(state: TreeState) -> dict[str, Any]:
    response = await call_tree_llm_json(
        verification_prompt(state["candidate_sections"], state["pages"]),
        "structure",
    )
    verified = [
        section
        for section in _assert_sections(response["json"])
        if section.get("valid") is not False
    ]
    accuracy = len(verified) / len(state["candidate_sections"])
    if accuracy < 0.6:
        raise RuntimeError(f"Tree verifier rechazo la estructura candidata: accuracy {accuracy}.")
    return {
        "metrics": {**state["metrics"], "verified_section_count": len(verified)},
        "verified_sections": verified,
    }


def post_process_tree(state: TreeState) -> dict[str, Any]:
    return {
        "tree": candidate_sections_to_tree(
            state["verified_sections"],
            state["pages"],
            state["source_blocks"],
        )
    }


async def summarize_tree(state: TreeState) -> dict[str, Any]:
    semaphore = asyncio.Semaphore(_summary_concurrency())
    flattened = flatten_tree(state["tree"])

    async def summarize_node(node: TreeNode) -> None:
        async with semaphore:
            response = await call_tree_llm_text(summary_prompt(node), "summary")
            node["summary"] = response["content"].strip()

    await asyncio.gather(*(summarize_node(node) for node, _path in flattened))
    doc_summary = (
        await call_tree_llm_text(doc_summary_prompt(state["tree"]), "summary")
    )["content"].strip()
    chunks = build_chunks_from_tree(state["tree"])
    return {
        "chunks": chunks,
        "doc_summary": doc_summary,
        "metrics": {**state["metrics"], "chunk_count": len(chunks)},
    }


def build_graph():
    graph = StateGraph(TreeState)
    graph.add_node("build_candidate_tree", build_candidate_tree)
    graph.add_node("verify_tree", verify_tree)
    graph.add_node("post_process_tree", post_process_tree)
    graph.add_node("summarize_tree", summarize_tree)
    graph.add_edge(START, "build_candidate_tree")
    graph.add_edge("build_candidate_tree", "verify_tree")
    graph.add_edge("verify_tree", "post_process_tree")
    graph.add_edge("post_process_tree", "summarize_tree")
    graph.add_edge("summarize_tree", END)
    return graph.compile()


TREE_GRAPH = build_graph()


async def run_tree_index_graph(
    document_title: str,
    pages: list[LabeledPage],
    source_blocks: list[SourceBlock] | None = None,
) -> dict[str, Any]:
    source_blocks = source_blocks or []
    result = await TREE_GRAPH.ainvoke(
        {
            "candidate_sections": [],
            "chunks": [],
            "doc_summary": "",
            "document_title": document_title,
            "metrics": {
                "candidate_section_count": 0,
                "chunk_count": 0,
                "llm_model": None,
                "llm_provider": None,
                "page_count": len(pages),
                "source_block_count": len(source_blocks),
                "verified_section_count": 0,
            },
            "pages": pages,
            "provider": "",
            "source_blocks": source_blocks,
            "tree": [],
            "verified_sections": [],
            "version": TREE_INDEXER_VERSION,
        }
    )
    return {
        "chunks": result["chunks"],
        "doc_summary": result["doc_summary"],
        "metrics": result["metrics"],
        "model": result["metrics"].get("llm_model") or "unknown",
        "provider": result["metrics"].get("llm_provider") or result["provider"],
        "source_blocks_coordinate_system": (
            SOURCE_BLOCKS_COORDINATE_SYSTEM if source_blocks else None
        ),
        "tree": result["tree"],
        "tree_for_storage": remove_node_text(result["tree"]),
        "version": result["version"],
    }
