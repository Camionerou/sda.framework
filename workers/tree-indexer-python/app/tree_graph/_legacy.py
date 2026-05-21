from __future__ import annotations

from typing import Any

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from .config import (
    degrade_attempt_limit as _degrade_attempt_limit,
    max_prompt_chars as _max_prompt_chars,
    refine_iteration_limit as _refine_iteration_limit,
    refine_max_pages as _refine_max_pages,
    refine_max_tokens as _refine_max_tokens,
    repair_attempt_limit as _repair_attempt_limit,
    summary_concurrency as _summary_concurrency,
)
from ..embeddings import embed_chunks
from ..llm import call_tree_llm_json, call_tree_llm_text
from ..pageindex_style import (
    CandidateSection,
    LabeledPage,
    SOURCE_BLOCKS_COORDINATE_SYSTEM,
    SourceBlock,
    TreeChunk,
    TreeNode,
    build_chunks_from_tree,
    candidate_sections_to_tree,
    estimate_tokens,
    flatten_tree,
    remove_node_text,
    split_pages_for_prompt,
    strip_repeated_headers_footers,
    tagged_pages_text,
)
from ..prompts import (
    DOCUMENT_TYPES,
    candidate_prompt,
    doc_summary_prompt,
    document_type_prompt,
    repair_sections_prompt,
    routing_summary_prompt,
    summary_prompt,
    verification_prompt,
)
from .state import NodeTask, NodeTextResult, RefinedNodeResult, TreeState
from ..versions import TREE_INDEXER_PYTHON_VERSION

TREE_INDEXER_VERSION = TREE_INDEXER_PYTHON_VERSION


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


def _assert_document_type(value: Any) -> str:
    raw_type = value.get("type") if isinstance(value, dict) else None
    document_type = raw_type.strip().lower() if isinstance(raw_type, str) else ""
    return document_type if document_type in DOCUMENT_TYPES else "other"


from .helpers import (
    is_large_leaf as _is_large_leaf_impl,
    node_from_task as _node_from_task,
    node_task as _node_task,
    ordered_unique_sections as _ordered_unique_sections,
    renumber_tree as _renumber_tree,
    section_identity as _section_identity,
    section_page as _section_page,
    shift_tree_pages as _shift_tree_pages,
    structure_sort_key as _structure_sort_key,
    sub_pages_for_node as _sub_pages_for_node,
    visit_tree as _visit_tree,
)


def _is_large_leaf(node: TreeNode) -> bool:
    return _is_large_leaf_impl(node, max_pages=_refine_max_pages(), max_tokens=_refine_max_tokens())


from .events import context_for_send as _context_for_send, emit_tree_node_event
from .nodes.degrade_mode import degrade_mode, fail_verification
from .nodes.detect_document_type import detect_document_type
from .nodes.post_process_tree import post_process_tree
from .nodes.repair_sections import repair_sections
from .nodes.embed_hierarchy import embed_hierarchy
from .nodes.verify_tree import verify_tree
from .nodes.routing_summary import collect_routing_summaries, summarize_one_routing
from .nodes.summarize_node import collect_summaries, prepare_summaries, summarize_one_node


async def build_candidate_tree(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Construyendo arbol candidato.",
        metadata={"tree_mode": state.get("tree_mode", "toc")},
        node="build_candidate_tree",
        progress=50,
        status="started",
    )
    groups = split_pages_for_prompt(state["prompt_pages"], _max_prompt_chars())
    sections: list[CandidateSection] = []
    model: str | None = None
    provider: str | None = None
    provider_order: list[str] = []
    service_tier: str | None = None

    for group in groups:
        response = await call_tree_llm_json(
            candidate_prompt(
                state["document_title"],
                state["document_type"],
                tagged_pages_text(group),
                sections if sections else None,
                state.get("tree_mode", "toc"),
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
    await emit_tree_node_event(
        state,
        message=f"Arbol candidato generado con {len(sections)} secciones.",
        metadata={"candidate_section_count": len(sections)},
        node="build_candidate_tree",
        progress=55,
        status="completed",
    )
    return {
        "candidate_sections": sections,
        "metrics": metrics,
        "provider": provider or "",
        "version": TREE_INDEXER_VERSION,
    }


def route_after_verify(state: TreeState) -> str:
    accuracy = float(state["metrics"].get("verification_accuracy") or 0)
    degrade_attempts = int(state["metrics"].get("degrade_attempts") or 0)
    invalid_count = len(state.get("invalid_sections", []))
    can_degrade = state["tree_mode"] != "no_toc" and degrade_attempts < _degrade_attempt_limit()
    if accuracy >= 0.95 or invalid_count == 0:
        return "post_process_tree"
    if accuracy >= 0.6 and state.get("repair_attempts", 0) < _repair_attempt_limit():
        return "repair_sections"
    if can_degrade and state.get("repair_attempts", 0) >= _repair_attempt_limit():
        return "degrade_mode"
    if can_degrade and accuracy < 0.6:
        return "degrade_mode"
    return "fail_verification"


async def _refined_subtree_for_node(state: TreeState, node: TreeNode) -> list[TreeNode] | None:
    sub_pages = _sub_pages_for_node(node, state["prompt_pages"])
    if len(sub_pages) <= 1:
        return None

    response = await call_tree_llm_json(
        candidate_prompt(
            node["title"],
            state["document_type"],
            tagged_pages_text(sub_pages),
            None,
            "refine",
        ),
        "structure",
    )
    candidate_sections = _assert_sections(response["json"])
    if len(candidate_sections) <= 1:
        return None

    verification = await call_tree_llm_json(
        verification_prompt(candidate_sections, sub_pages),
        "structure",
    )
    verified = [
        section
        for section in _assert_sections(verification["json"])
        if section.get("valid") is not False
    ]
    if len(verified) <= 1 or len(verified) / len(candidate_sections) < 0.6:
        return None

    subtree = candidate_sections_to_tree(verified, sub_pages)
    if len(flatten_tree(subtree)) <= 1:
        return None

    return _shift_tree_pages(subtree, node["start_index"] - 1)


async def refine_large_nodes(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Buscando nodos grandes para refinamiento recursivo.",
        node="refine_large_nodes",
        progress=74,
        status="started",
    )
    refined_count = 0
    tree = state["tree"]
    candidates = [node for node in _visit_tree(tree) if _is_large_leaf(node)]

    for node in candidates:
        subtree = await _refined_subtree_for_node(state, node)
        if not subtree:
            continue
        node["nodes"] = subtree
        refined_count += 1

    if refined_count:
        _renumber_tree(tree)

    iteration = state.get("refinement_iteration", 0) + 1
    await emit_tree_node_event(
        state,
        message=f"Refinamiento completo: {refined_count} nodos refinados.",
        metadata={
            "large_node_count": len(candidates),
            "refined_node_count": refined_count,
            "refinement_iteration": iteration,
        },
        node="refine_large_nodes",
        progress=76,
        status="completed",
    )
    return {
        "metrics": {
            **state["metrics"],
            "last_refined_node_count": refined_count,
            "refinement_iteration": iteration,
            "refined_node_count": state["metrics"].get("refined_node_count", 0) + refined_count,
        },
        "refinement_iteration": iteration,
        "tree": tree,
    }


def route_after_refine(state: TreeState) -> str:
    refined = int(state["metrics"].get("last_refined_node_count") or 0)
    iteration = int(state.get("refinement_iteration", 0))
    if refined > 0 and iteration < _refine_iteration_limit():
        return "refine_large_nodes"
    return "prepare_summaries"


def fan_out_summaries(state: TreeState) -> list[Send]:
    context = _context_for_send(state)
    return [
        Send(
            "summarize_one_node",
            {
                **context,
                "summary_target": _node_task(node, path),
            },
        )
        for node, path in flatten_tree(state["tree"])
    ]


def fan_out_routing_summaries(state: TreeState) -> list[Send]:
    context = _context_for_send(state)
    return [
        Send(
            "summarize_one_routing",
            {
                **context,
                "routing_target": _node_task(node, path),
            },
        )
        for node, path in flatten_tree(state["tree"])
    ]


def build_graph(checkpointer: Any | None = None):
    graph = StateGraph(TreeState)
    graph.add_node("collect_routing_summaries", collect_routing_summaries)
    graph.add_node("collect_summaries", collect_summaries)
    graph.add_node("detect_document_type", detect_document_type)
    graph.add_node("build_candidate_tree", build_candidate_tree)
    graph.add_node("degrade_mode", degrade_mode)
    graph.add_node("embed_hierarchy", embed_hierarchy)
    graph.add_node("fail_verification", fail_verification)
    graph.add_node("prepare_summaries", prepare_summaries)
    graph.add_node("refine_large_nodes", refine_large_nodes)
    graph.add_node("repair_sections", repair_sections)
    graph.add_node("summarize_one_node", summarize_one_node)
    graph.add_node("summarize_one_routing", summarize_one_routing)
    graph.add_node("verify_tree", verify_tree)
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
    graph.add_edge("post_process_tree", "refine_large_nodes")
    graph.add_conditional_edges(
        "refine_large_nodes",
        route_after_refine,
        {
            "prepare_summaries": "prepare_summaries",
            "refine_large_nodes": "refine_large_nodes",
        },
    )
    graph.add_conditional_edges(
        "prepare_summaries",
        fan_out_summaries,
        ["summarize_one_node"],
    )
    graph.add_edge("summarize_one_node", "collect_summaries")
    graph.add_conditional_edges(
        "collect_summaries",
        fan_out_routing_summaries,
        ["summarize_one_routing"],
    )
    graph.add_edge("summarize_one_routing", "collect_routing_summaries")
    graph.add_edge("collect_routing_summaries", "embed_hierarchy")
    graph.add_edge("embed_hierarchy", END)
    return graph.compile(checkpointer=checkpointer)


from .checkpoint import (
    is_checkpointing_configured,
    run_graph_with_optional_checkpoint as _run_graph_with_optional_checkpoint_impl,
)


async def _run_graph_with_optional_checkpoint(initial_state, *, thread_id):
    return await _run_graph_with_optional_checkpoint_impl(
        build_graph, TREE_GRAPH, initial_state, thread_id=thread_id
    )


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
    result = await _run_graph_with_optional_checkpoint(
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
