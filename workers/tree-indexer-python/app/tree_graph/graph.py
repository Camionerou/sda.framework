from __future__ import annotations

from typing import Any

import httpx
from langgraph.graph import END, START, StateGraph
from langgraph.types import RetryPolicy

from ..llm import TreeLlmTransientError
from ..pageindex_style import (
    SOURCE_BLOCKS_COORDINATE_SYSTEM,
    LabeledPage,
    SourceBlock,
    remove_node_text,
    strip_repeated_headers_footers,
)
from ..versions import TREE_INDEXER_PYTHON_VERSION
from .checkpoint import run_graph_with_optional_checkpoint
from .nodes.build_candidate_tree import build_candidate_tree
from .nodes.degrade_mode import degrade_mode, fail_verification
from .nodes.detect_document_type import detect_document_type
from .nodes.embed_hierarchy import embed_hierarchy
from .nodes.collect_refined_results import collect_refined_results
from .nodes.collect_summaries import collect_summaries
from .nodes.post_process_tree import post_process_tree
from .nodes.prepare_summaries import prepare_summaries
from .nodes.refine_one_node import refine_one_node
from .nodes.repair_sections import repair_sections
from .nodes.routing_summary import collect_routing_summaries, summarize_one_routing
from .nodes.summarize_node import summarize_one_node
from .nodes.verify_tree import verify_tree
from .routing import (
    fan_out_refine_targets,
    fan_out_routing_summaries,
    fan_out_summaries,
    route_after_refine,
    route_after_refine_collect,
    route_after_verify,
)
from .state import TreeState

LLM_RETRY = RetryPolicy(
    max_attempts=3,
    initial_interval=2.0,
    backoff_factor=2.0,
    retry_on=(
        TreeLlmTransientError,
        httpx.TimeoutException,
        httpx.ReadError,
        httpx.RemoteProtocolError,
        httpx.ConnectError,
    ),
)

TREE_INDEXER_VERSION = TREE_INDEXER_PYTHON_VERSION


def _select_refine_targets(state: TreeState) -> dict:
    return {}


def build_graph(checkpointer: Any | None = None):
    graph = StateGraph(TreeState)
    graph.add_node("collect_refined_results", collect_refined_results)
    graph.add_node("collect_routing_summaries", collect_routing_summaries)
    graph.add_node("collect_summaries", collect_summaries)
    graph.add_node("detect_document_type", detect_document_type, retry_policy=LLM_RETRY)
    graph.add_node("build_candidate_tree", build_candidate_tree, retry_policy=LLM_RETRY)
    graph.add_node("degrade_mode", degrade_mode)
    graph.add_node("embed_hierarchy", embed_hierarchy, retry_policy=LLM_RETRY)
    graph.add_node("fail_verification", fail_verification)
    graph.add_node("prepare_summaries", prepare_summaries)
    graph.add_node("refine_one_node", refine_one_node, retry_policy=LLM_RETRY)
    graph.add_node("repair_sections", repair_sections, retry_policy=LLM_RETRY)
    graph.add_node("select_refine_targets", _select_refine_targets)
    graph.add_node("summarize_one_node", summarize_one_node, retry_policy=LLM_RETRY)
    graph.add_node("summarize_one_routing", summarize_one_routing, retry_policy=LLM_RETRY)
    graph.add_node("verify_tree", verify_tree, retry_policy=LLM_RETRY)
    graph.add_node("post_process_tree", post_process_tree)
    graph.add_edge(START, "detect_document_type")
    graph.add_edge("detect_document_type", "build_candidate_tree")
    graph.add_edge("build_candidate_tree", "verify_tree")
    graph.add_conditional_edges(
        "verify_tree",
        route_after_verify,
        {
            "degrade_mode": "degrade_mode",
            "fail_verification": "fail_verification",
            "post_process_tree": "post_process_tree",
            "repair_sections": "repair_sections",
        },
    )
    graph.add_edge("repair_sections", "verify_tree")
    graph.add_edge("degrade_mode", "build_candidate_tree")
    graph.add_edge("post_process_tree", "select_refine_targets")
    graph.add_conditional_edges("select_refine_targets", fan_out_refine_targets, ["refine_one_node"])
    graph.add_edge("refine_one_node", "collect_refined_results")
    graph.add_conditional_edges(
        "collect_refined_results",
        route_after_refine_collect,
        {
            "select_refine_targets": "select_refine_targets",
            "prepare_summaries": "prepare_summaries",
        },
    )
    graph.add_conditional_edges("prepare_summaries", fan_out_summaries, ["summarize_one_node"])
    graph.add_edge("summarize_one_node", "collect_summaries")
    graph.add_conditional_edges("collect_summaries", fan_out_routing_summaries, ["summarize_one_routing"])
    graph.add_edge("summarize_one_routing", "collect_routing_summaries")
    graph.add_edge("collect_routing_summaries", "embed_hierarchy")
    graph.add_edge("embed_hierarchy", END)
    return graph.compile(checkpointer=checkpointer)


TREE_GRAPH = build_graph()


async def run_tree_index_graph(
    document_title: str,
    pages: list[LabeledPage],
    source_blocks: list[SourceBlock] | None = None,
    *,
    document_id: str = "",
    job_id: str = "",
    run_id: str = "",
    tenant_id: str = "",
) -> dict[str, Any]:
    source_blocks = source_blocks or []
    raw_pages = pages
    prompt_pages = strip_repeated_headers_footers(raw_pages)
    initial_state: TreeState = {
        "candidate_sections": [],
        "chunks": [],
        "doc_summary": "",
        "document_id": document_id,
        "document_title": document_title,
        "document_type": "other",
        "invalid_sections": [],
        "job_id": job_id,
        "metrics": {
            "candidate_section_count": 0,
            "chunk_count": 0,
            "degrade_attempts": 0,
            "llm_model": None,
            "llm_provider": None,
            "page_count": len(raw_pages),
            "repair_attempts": 0,
            "source_block_count": len(source_blocks),
            "verified_section_count": 0,
        },
        "raw_pages": raw_pages,
        "prompt_pages": prompt_pages,
        "provider": "",
        "refined_results": [],
        "refinement_iteration": 0,
        "repair_attempts": 0,
        "routing_summary": "",
        "routing_summary_results": [],
        "run_id": run_id,
        "source_blocks": source_blocks,
        "summary_cache_hits": 0,
        "summary_cache_misses": 0,
        "summary_results": [],
        "tenant_id": tenant_id,
        "tree": [],
        "tree_mode": "toc",
        "verified_sections": [],
        "version": TREE_INDEXER_VERSION,
    }
    result = await run_graph_with_optional_checkpoint(
        build_graph,
        TREE_GRAPH,
        initial_state,
        thread_id=job_id or run_id or document_id or "tree-index",
    )
    return {
        "chunks": result["chunks"],
        "doc_summary": result["doc_summary"],
        "document_type": result["document_type"],
        "metrics": result["metrics"],
        "model": result["metrics"].get("llm_model") or "unknown",
        "provider": result["metrics"].get("llm_provider") or result["provider"],
        "routing_summary": result["routing_summary"],
        "source_blocks_coordinate_system": (
            SOURCE_BLOCKS_COORDINATE_SYSTEM if source_blocks else None
        ),
        "tree": result["tree"],
        "tree_for_storage": remove_node_text(result["tree"]),
        "version": result["version"],
    }
