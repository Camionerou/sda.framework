from __future__ import annotations

import asyncio
import json
import os
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from .llm import call_tree_llm_json, call_tree_llm_text
from .pageindex_style import (
    CandidateSection,
    LabeledPage,
    TreeChunk,
    TreeNode,
    build_chunks_from_tree,
    candidate_sections_to_tree,
    flatten_tree,
    remove_node_text,
    split_pages_for_prompt,
    tagged_pages_text,
)

TREE_INDEXER_VERSION = "sda-pageindex-python-langgraph-v0.1.0"


class TreeState(TypedDict):
    candidate_sections: list[CandidateSection]
    chunks: list[TreeChunk]
    doc_summary: str
    document_title: str
    metrics: dict[str, Any]
    pages: list[LabeledPage]
    provider: str
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


def _candidate_prompt(
    document_title: str,
    group_text: str,
    previous: list[CandidateSection] | None,
) -> str:
    previous_json = json.dumps(previous, ensure_ascii=False, indent=2) if previous else ""
    previous_text = (
        "Generate the initial structure from the current text."
        if not previous
        else f"""Previous tree structure:
{previous_json}

Continue the structure with only additional sections found in the current text."""
    )
    return f"""You are an expert in extracting hierarchical tree structure.

Your task is to generate the tree structure of the document, following the PageIndex method.

The "structure" field is the numeric hierarchy code. Examples: "1", "1.1", "1.1.1".
For "title", extract the original section title from the text and only fix spacing inconsistencies.
The provided text contains tags like <physical_index_X> indicating the physical page number.
For "physical_index", return the tag where the section starts.

Document title: {document_title}

{previous_text}

Current text:
{group_text}

Return only JSON:
{{
  "sections": [
    {{
      "structure": "1.2",
      "title": "Original section title",
      "physical_index": "<physical_index_12>"
    }}
  ]
}}"""


def _verification_prompt(sections: list[CandidateSection], pages: list[LabeledPage]) -> str:
    evidence = []
    for section in sections:
        raw_index = section.get("physical_index")
        if isinstance(raw_index, int):
            physical_index = raw_index
        else:
            digits = "".join(char for char in str(raw_index) if char.isdigit())
            physical_index = int(digits) if digits else 0
        page = next((candidate for candidate in pages if candidate["page"] == physical_index), None)
        evidence.append(
            {
                "page_excerpt": (page or {}).get("text", "")[:2500],
                "physical_index": raw_index,
                "structure": section.get("structure"),
                "title": section.get("title"),
            }
        )

    return f"""You are verifying a PageIndex-style document tree.

For each section, check whether the title appears or starts in its assigned page excerpt.
Use fuzzy matching and ignore spacing inconsistencies. Do not invent new sections.
Set appear_start to "yes" only when the title starts at the beginning of the page excerpt.

Candidate sections with page excerpts:
{json.dumps(evidence, ensure_ascii=False, indent=2)}

Return only JSON:
{{
  "sections": [
    {{
      "structure": "1.2",
      "title": "Original section title",
      "physical_index": "<physical_index_12>",
      "valid": true,
      "appear_start": "yes",
      "reason": "short reason"
    }}
  ]
}}"""


def _summary_prompt(node: TreeNode) -> str:
    return f"""You are given a part of a document.
Generate a concise description of the main points covered in this partial document.
Do not add any text outside the description.

Section title: {node["title"]}
Page range: {node["start_index"]}-{node["end_index"]}

Partial document text:
{node.get("text", "")[:24000]}"""


def _doc_summary_prompt(tree: list[TreeNode]) -> str:
    return f"""You are an expert in generating descriptions for a document.
You are given the PageIndex-style structure of a document.
Generate a one-sentence description that makes this document easy to distinguish from other documents.
Do not add any text outside the description.

Document structure:
{json.dumps(remove_node_text(tree), ensure_ascii=False, indent=2)}"""


async def build_candidate_tree(state: TreeState) -> dict[str, Any]:
    groups = split_pages_for_prompt(state["pages"], _max_prompt_chars())
    sections: list[CandidateSection] = []
    model: str | None = None
    provider: str | None = None

    for group in groups:
        response = await call_tree_llm_json(
            _candidate_prompt(
                state["document_title"],
                tagged_pages_text(group),
                sections if sections else None,
            ),
            "structure",
        )
        sections.extend(_assert_sections(response["json"]))
        model = response["model"]
        provider = response["provider"]

    if not sections:
        raise RuntimeError("Tree LLM no encontro secciones para construir el arbol.")

    metrics = {
        **state["metrics"],
        "candidate_section_count": len(sections),
        "llm_model": model,
        "llm_provider": provider,
    }
    return {
        "candidate_sections": sections,
        "metrics": metrics,
        "provider": provider or "",
        "version": TREE_INDEXER_VERSION,
    }


async def verify_tree(state: TreeState) -> dict[str, Any]:
    response = await call_tree_llm_json(
        _verification_prompt(state["candidate_sections"], state["pages"]),
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
    return {"tree": candidate_sections_to_tree(state["verified_sections"], state["pages"])}


async def summarize_tree(state: TreeState) -> dict[str, Any]:
    semaphore = asyncio.Semaphore(_summary_concurrency())
    flattened = flatten_tree(state["tree"])

    async def summarize_node(node: TreeNode) -> None:
        async with semaphore:
            response = await call_tree_llm_text(_summary_prompt(node), "summary")
            node["summary"] = response["content"].strip()

    await asyncio.gather(*(summarize_node(node) for node, _path in flattened))
    doc_summary = (
        await call_tree_llm_text(_doc_summary_prompt(state["tree"]), "summary")
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


async def run_tree_index_graph(document_title: str, pages: list[LabeledPage]) -> dict[str, Any]:
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
                "verified_section_count": 0,
            },
            "pages": pages,
            "provider": "",
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
        "tree": result["tree"],
        "tree_for_storage": remove_node_text(result["tree"]),
        "version": result["version"],
    }
