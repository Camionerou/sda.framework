from __future__ import annotations

import operator
from typing import Annotated, Any, TypedDict

from ..pageindex_style import CandidateSection, LabeledPage, SourceBlock, TreeChunk, TreeNode


class NodeTask(TypedDict):
    end_index: int
    node_id: str
    path: list[str]
    start_index: int
    summary: str
    text: str
    title: str


class NodeTextResult(TypedDict):
    node_id: str
    text: str


class RefinedNodeResult(TypedDict):
    node_id: str
    subtree: list[TreeNode] | None


class TreeState(TypedDict, total=False):
    candidate_sections: list[CandidateSection]
    chunks: list[TreeChunk]
    doc_summary: str
    document_id: str
    document_title: str
    document_type: str
    invalid_sections: list[CandidateSection]
    job_id: str
    metrics: dict[str, Any]
    prompt_pages: list[LabeledPage]
    raw_pages: list[LabeledPage]
    provider: str
    refine_target_node_id: str | None
    refine_target_pages: list[LabeledPage] | None
    refine_target_start_index: int | None
    refined_results: Annotated[list[RefinedNodeResult], operator.add]
    refinement_iteration: int
    repair_attempts: int
    routing_summary: str
    routing_summary_results: Annotated[list[NodeTextResult], operator.add]
    routing_target: NodeTask
    run_id: str
    source_blocks: list[SourceBlock]
    summary_cache_hits: Annotated[int, operator.add]
    summary_cache_misses: Annotated[int, operator.add]
    summary_results: Annotated[list[NodeTextResult], operator.add]
    summary_target: NodeTask
    tenant_id: str
    tree: list[TreeNode]
    tree_mode: str
    verified_sections: list[CandidateSection]
    version: str
