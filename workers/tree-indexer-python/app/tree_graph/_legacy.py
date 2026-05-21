from __future__ import annotations

import os
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
from ..events import publish_inngest_event
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


def _graph_event_base(state: TreeState) -> dict[str, Any] | None:
    tenant_id = state.get("tenant_id")
    document_id = state.get("document_id")
    run_id = state.get("run_id")
    job_id = state.get("job_id")
    if not all(isinstance(value, str) and value for value in [tenant_id, document_id, run_id, job_id]):
        return None
    return {
        "document_id": document_id,
        "job_id": job_id,
        "run_id": run_id,
        "tenant_id": tenant_id,
    }


async def emit_tree_node_event(
    state: TreeState,
    *,
    message: str,
    metadata: dict[str, Any] | None = None,
    node: str,
    progress: int,
    status: str,
) -> None:
    base = _graph_event_base(state)
    if not base:
        return
    await publish_inngest_event(
        "indexing/tree.node",
        {
            **base,
            "message": message,
            "metadata": metadata or {},
            "node": node,
            "progress": progress,
            "stage": "structuring",
            "status": status,
        },
    )


def _context_for_send(state: TreeState) -> dict[str, str]:
    return {
        "document_id": state.get("document_id", ""),
        "document_title": state.get("document_title", ""),
        "document_type": state.get("document_type", "other"),
        "job_id": state.get("job_id", ""),
        "run_id": state.get("run_id", ""),
        "tenant_id": state.get("tenant_id", ""),
    }


async def detect_document_type(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Detectando tipo documental.",
        node="detect_document_type",
        progress=46,
        status="started",
    )
    response = await call_tree_llm_json(
        document_type_prompt(
            state["document_title"],
            tagged_pages_text(state["prompt_pages"][:3]),
        ),
        "summary",
    )
    document_type = _assert_document_type(response["json"])
    await emit_tree_node_event(
        state,
        message=f"Tipo documental detectado: {document_type}.",
        metadata={"document_type": document_type},
        node="detect_document_type",
        progress=48,
        status="completed",
    )
    return {
        "document_type": document_type,
        "metrics": {
            **state["metrics"],
            "document_type": document_type,
            "document_type_model": response["model"],
            "document_type_provider": response["provider"],
        },
    }


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


async def verify_tree(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Verificando arbol candidato.",
        node="verify_tree",
        progress=58,
        status="started",
    )
    response = await call_tree_llm_json(
        verification_prompt(state["candidate_sections"], state["prompt_pages"]),
        "structure",
    )
    checked_sections = _assert_sections(response["json"])
    verified = [
        section
        for section in checked_sections
        if section.get("valid") is not False
    ]
    invalid = [
        section
        for section in checked_sections
        if section.get("valid") is False
    ]
    checked_identities = {_section_identity(section) for section in checked_sections}
    invalid.extend(
        {
            **section,
            "reason": "Verifier omitted this candidate section.",
            "valid": False,
        }
        for section in state["candidate_sections"]
        if _section_identity(section) not in checked_identities
    )
    accuracy = len(verified) / len(state["candidate_sections"])
    await emit_tree_node_event(
        state,
        message=f"Verificacion completada con accuracy {accuracy:.2f}.",
        metadata={
            "invalid_section_count": len(invalid),
            "verification_accuracy": accuracy,
            "verified_section_count": len(verified),
        },
        node="verify_tree",
        progress=62,
        status="completed",
    )
    return {
        "invalid_sections": invalid,
        "metrics": {
            **state["metrics"],
            "invalid_section_count": len(invalid),
            "verification_accuracy": accuracy,
            "verified_section_count": len(verified),
        },
        "verified_sections": verified,
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


async def repair_sections(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Reparando secciones invalidas.",
        metadata={"invalid_section_count": len(state.get("invalid_sections", []))},
        node="repair_sections",
        progress=64,
        status="started",
    )
    response = await call_tree_llm_json(
        repair_sections_prompt(
            state["document_title"],
            state["document_type"],
            state["verified_sections"],
            state["invalid_sections"],
            state["prompt_pages"],
        ),
        "structure",
    )
    repaired = _assert_sections(response["json"])
    candidate_sections = _ordered_unique_sections([*state["verified_sections"], *repaired])
    if not candidate_sections:
        raise RuntimeError("Tree repair no devolvio secciones recuperables.")
    await emit_tree_node_event(
        state,
        message=f"Reparacion genero {len(repaired)} secciones candidatas.",
        metadata={"repair_section_count": len(repaired)},
        node="repair_sections",
        progress=66,
        status="completed",
    )
    return {
        "candidate_sections": candidate_sections,
        "invalid_sections": [],
        "metrics": {
            **state["metrics"],
            "candidate_section_count": len(candidate_sections),
            "repair_attempts": state.get("repair_attempts", 0) + 1,
            "repair_section_count": len(repaired),
        },
        "repair_attempts": state.get("repair_attempts", 0) + 1,
        "verified_sections": [],
    }


async def degrade_mode(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Degradando extraccion a modo no_toc.",
        node="degrade_mode",
        progress=68,
        status="completed",
    )
    return {
        "candidate_sections": [],
        "invalid_sections": [],
        "metrics": {
            **state["metrics"],
            "degrade_attempts": state["metrics"].get("degrade_attempts", 0) + 1,
            "repair_attempts": 0,
            "tree_mode": "no_toc",
        },
        "repair_attempts": 0,
        "tree_mode": "no_toc",
        "verified_sections": [],
    }


def fail_verification(state: TreeState) -> dict[str, Any]:
    accuracy = state["metrics"].get("verification_accuracy")
    invalid_count = len(state.get("invalid_sections", []))
    raise RuntimeError(
        f"Tree verifier rechazo la estructura candidata: accuracy {accuracy}, "
        f"invalid_sections {invalid_count}."
    )


async def post_process_tree(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Normalizando arbol verificado.",
        node="post_process_tree",
        progress=70,
        status="started",
    )
    tree = candidate_sections_to_tree(
        state["verified_sections"],
        state["raw_pages"],
        state["source_blocks"],
    )
    await emit_tree_node_event(
        state,
        message=f"Arbol normalizado con {len(flatten_tree(tree))} nodos.",
        metadata={"tree_node_count": len(flatten_tree(tree))},
        node="post_process_tree",
        progress=72,
        status="completed",
    )
    return {
        "tree": tree
    }


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


def prepare_summaries(state: TreeState) -> dict[str, Any]:
    return {
        "metrics": {
            **state["metrics"],
            "tree_node_count": len(flatten_tree(state["tree"])),
        }
    }


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


async def summarize_one_node(state: TreeState) -> dict[str, Any]:
    target = state["summary_target"]
    await emit_tree_node_event(
        state,
        message=f"Resumiendo nodo {target['node_id']}.",
        metadata={"node_id": target["node_id"], "title": target["title"]},
        node="summarize_one_node",
        progress=80,
        status="started",
    )
    response = await call_tree_llm_text(summary_prompt(_node_from_task(target)), "summary")
    summary = response["content"].strip()
    await emit_tree_node_event(
        state,
        message=f"Resumen de nodo {target['node_id']} listo.",
        metadata={"node_id": target["node_id"]},
        node="summarize_one_node",
        progress=82,
        status="completed",
    )
    return {"summary_results": [{"node_id": target["node_id"], "text": summary}]}


async def collect_summaries(state: TreeState) -> dict[str, Any]:
    by_node_id = {result["node_id"]: result["text"] for result in state.get("summary_results", [])}
    for node in _visit_tree(state["tree"]):
        if summary := by_node_id.get(node["node_id"]):
            node["summary"] = summary
    doc_summary = (
        await call_tree_llm_text(doc_summary_prompt(state["tree"]), "summary")
    )["content"].strip()
    return {
        "doc_summary": doc_summary,
        "metrics": {**state["metrics"], "summary_node_count": len(by_node_id)},
    }


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


async def summarize_one_routing(state: TreeState) -> dict[str, Any]:
    target = state["routing_target"]
    await emit_tree_node_event(
        state,
        message=f"Generando routing summary para nodo {target['node_id']}.",
        metadata={"node_id": target["node_id"], "title": target["title"]},
        node="summarize_one_routing",
        progress=86,
        status="started",
    )
    response = await call_tree_llm_text(
        routing_summary_prompt(_node_from_task(target), target["path"], state["document_type"]),
        "summary",
    )
    routing_summary = response["content"].strip()
    await emit_tree_node_event(
        state,
        message=f"Routing summary de nodo {target['node_id']} listo.",
        metadata={"node_id": target["node_id"]},
        node="summarize_one_routing",
        progress=88,
        status="completed",
    )
    return {"routing_summary_results": [{"node_id": target["node_id"], "text": routing_summary}]}


def collect_routing_summaries(state: TreeState) -> dict[str, Any]:
    by_node_id = {
        result["node_id"]: result["text"]
        for result in state.get("routing_summary_results", [])
    }
    for node in _visit_tree(state["tree"]):
        if routing_summary := by_node_id.get(node["node_id"]):
            node["routing_summary"] = routing_summary
    chunks = build_chunks_from_tree(state["tree"], document_type=state["document_type"])
    root_routing = "\n".join(
        node.get("routing_summary", "").strip()
        for node in state["tree"]
        if node.get("routing_summary", "").strip()
    )
    return {
        "chunks": chunks,
        "metrics": {
            **state["metrics"],
            "chunk_count": len(chunks),
            "routing_summary_node_count": len(by_node_id),
        },
        "routing_summary": root_routing,
    }


async def embed_hierarchy(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Generando embeddings jerarquicos.",
        metadata={"chunk_count": len(state["chunks"])},
        node="embed_hierarchy",
        progress=92,
        status="started",
    )
    embedded_chunks, config = await embed_chunks(
        state["chunks"],
        document_type=state["document_type"],
    )
    await emit_tree_node_event(
        state,
        message=f"Embeddings jerarquicos listos: {len(embedded_chunks)} vectores.",
        metadata={
            "embedding_count": len(embedded_chunks),
            "embedding_dimension": config.dimensions,
            "embedding_model": config.model,
            "embedding_provider": config.provider,
        },
        node="embed_hierarchy",
        progress=96,
        status="completed",
    )
    return {
        "chunks": embedded_chunks,
        "metrics": {
            **state["metrics"],
            "embedding_count": len(embedded_chunks),
            "embedding_dimension": config.dimensions,
            "embedding_model": config.model,
            "embedding_provider": config.provider,
        },
    }


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


def _checkpoint_dsn() -> str | None:
    return (
        os.getenv("SDA_TREE_CHECKPOINT_DSN")
        or os.getenv("SDA_LANGGRAPH_CHECKPOINT_DSN")
        or os.getenv("SUPABASE_POOLER_URL")
        or os.getenv("DATABASE_URL")
    )


def _checkpointing_enabled() -> bool:
    value = os.getenv("SDA_TREE_CHECKPOINTING")
    if value is not None and value != "":
        return value.lower() not in {"0", "false", "no", "off"}
    return bool(_checkpoint_dsn())


def is_checkpointing_configured() -> bool:
    return bool(_checkpoint_dsn() and _checkpointing_enabled())


async def _run_graph_with_optional_checkpoint(
    initial_state: TreeState,
    *,
    thread_id: str,
) -> dict[str, Any]:
    dsn = _checkpoint_dsn()
    if not dsn or not _checkpointing_enabled():
        return await TREE_GRAPH.ainvoke(initial_state)

    try:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    except ImportError as error:
        raise RuntimeError(
            "SDA_TREE_CHECKPOINTING requiere instalar langgraph-checkpoint-postgres."
        ) from error

    async with AsyncPostgresSaver.from_conn_string(dsn) as checkpointer:
        if os.getenv("SDA_TREE_CHECKPOINT_SETUP") == "1":
            await checkpointer.setup()
        graph = build_graph(checkpointer=checkpointer)
        return await graph.ainvoke(
            initial_state,
            config={"configurable": {"thread_id": thread_id}},
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
