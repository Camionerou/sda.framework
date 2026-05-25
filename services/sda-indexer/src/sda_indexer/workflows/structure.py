"""LangGraph workflow para extract_structure. Wave 1: markdown + PDF.

Datapath crítico (spec §5.4): el signed_url NO va en el state. Cada
resume regenera signed_url fresca via supabase.storage.create_signed_url
porque el TTL (60min) puede expirar entre checkpoints.

State only stores JSON-safe types (str, int, list[dict], bool) — LangGraph
serializes the state into the checkpointer between nodes.
"""

import hashlib
from typing import TypedDict

import structlog
from langgraph.graph import StateGraph, START, END

from ..db.client import DB
from ..db import documents
from ..llm.client import LLMClient
from ..llm.router import Phase, aroute
from ..pipeline.parser.markdown_regex import parse_markdown_to_headers
from ..pipeline.parser.pdf_mineru import MineruClient, ParseRequest, MineruError
from ..pipeline.splitter.large_node import SplitConfig, split_text_by_tokens
from ..pipeline.structure import (
    index_extractor, repair, toc_detector, toc_transformer, validator,
)
from ..pipeline.structure.types import TocNode
from ..pipeline.tree.builder import build_tree, flatten
from ..settings.client import SettingsClient

log = structlog.get_logger()


class State(TypedDict, total=False):
    document_id: str
    source_path: str
    source_type: str
    md_content: str
    page_count: int
    parser_used: str
    path_used: str
    toc_nodes: list[dict]            # serializados a dicts JSON-safe
    doc_summary_short: str
    node_count: int
    aborted: bool


def build_graph(
    *,
    db: DB,
    supabase,
    settings: SettingsClient,
    llm: LLMClient,
    mineru: MineruClient,
    checkpointer=None,
):
    async def load_document(s: State) -> dict:
        """Carga el doc desde DB. signed_url se regenera dentro de parse_pdf_path."""
        doc = await documents.get_document(db.pool, s["document_id"])
        return {
            "source_path": doc["source_path"],
            "source_type": doc["source_type"] or "markdown",
        }

    def route_after_load(s: State) -> str:
        return "markdown" if s["source_type"] == "markdown" else "pdf"

    async def parse_markdown_path(s: State) -> dict:
        """Wave 0 path: descarga blob de Storage y decode."""
        resp = supabase.storage.from_("docs").download(s["source_path"])
        raw = resp if isinstance(resp, bytes) else resp.read()
        content = raw.decode("utf-8")
        return {
            "md_content": content,
            "page_count": 0,
            "parser_used": "native",
            "path_used": "fast",
        }

    async def parse_pdf_path(s: State) -> dict:
        """Wave 1 path: signed_url + POST /parse al mineru service."""
        signed = supabase.storage.from_("docs").create_signed_url(
            s["source_path"], 3600,
        )
        signed_url = signed["signedURL"] if isinstance(signed, dict) else signed.signedURL
        raw = supabase.storage.from_("docs").download(s["source_path"])
        sha = hashlib.sha256(raw).hexdigest()

        try:
            resp = await mineru.parse(ParseRequest(
                doc_id=s["document_id"],
                signed_url=signed_url,
                expected_sha256=sha,
            ))
        except MineruError as e:
            log.error(
                "structure.mineru_failed",
                document_id=s["document_id"],
                failure_reason=e.failure_reason,
            )
            raise

        meta = resp.metadata
        return {
            "md_content": resp.markdown,
            "page_count": meta["page_count"],
            "parser_used": meta["parser_used"],
            "path_used": meta["path_used"],
        }

    async def detect_and_extract_toc(s: State) -> dict:
        """LLM-driven TOC detection + transform, con fallback a index_extractor."""
        cfg_toc = await aroute(Phase.TOC, settings=settings, document_id=s["document_id"])

        # doc_summary_short heurístico Wave 1: primeros 600 chars del markdown.
        # Wave 2: 1 LLM call dedicada que produce un resumen mejor.
        doc_summary_short = s["md_content"][:600]

        detection = await toc_detector.detect_toc(
            llm=llm, model=cfg_toc.model,
            markdown=s["md_content"],
            doc_summary_short=doc_summary_short,
            max_scan_pages=await settings.resolve("pageindex.toc_detection_max_pages"),
            temperature=cfg_toc.temperature,
        )

        if detection.has_toc:
            nodes = await toc_transformer.transform_toc(
                llm=llm, model=cfg_toc.model,
                toc_raw=detection.toc_raw,
                doc_summary_short=doc_summary_short,
                temperature=cfg_toc.temperature,
            )
        else:
            cfg_struct = await aroute(Phase.STRUCTURE, settings=settings, document_id=s["document_id"])
            nodes = await index_extractor.extract_index(
                llm=llm, model=cfg_struct.model,
                markdown=s["md_content"],
                doc_summary_short=doc_summary_short,
                chunk_size_pages=10,
                temperature=cfg_struct.temperature,
            )

        return {
            "toc_nodes": [{"title": n.title, "depth": n.depth, "page_start": n.page_start} for n in nodes],
            "doc_summary_short": doc_summary_short,
        }

    async def validate_and_repair(s: State) -> dict:
        """Validator → si !ok → repair (cap 2 iter). Sino propaga."""
        max_depth = await settings.resolve("pageindex.max_tree_depth")
        page_count = s.get("page_count", 9999) or 9999

        nodes = [TocNode(**d) for d in s["toc_nodes"]]
        v = validator.validate_tree(nodes, total_pages=page_count, max_depth=max_depth)
        if v.ok:
            return {}

        cfg = await aroute(Phase.REPAIR, settings=settings, document_id=s["document_id"])
        try:
            fixed, iters = await repair.repair_tree(
                llm=llm, model=cfg.model,
                nodes=nodes, total_pages=page_count, max_depth=max_depth,
                doc_summary_short=s["doc_summary_short"],
                max_iterations=2,
                temperature=cfg.temperature,
            )
        except repair.RepairLoopExhausted as e:
            log.error("structure.unreparable", document_id=s["document_id"], err=str(e))
            raise

        return {
            "toc_nodes": [{"title": n.title, "depth": n.depth, "page_start": n.page_start} for n in fixed],
        }

    async def persist_tree(s: State) -> dict:
        """Convierte TocNode/FlatHeader → tree_nodes + split + insert."""
        max_tokens = await settings.resolve("pageindex.max_tokens_per_node")
        min_tokens = await settings.resolve("pageindex.min_tokens_per_node")
        split_cfg = SplitConfig(max_tokens=max_tokens, min_tokens=min_tokens)

        if s["source_type"] == "markdown":
            headers = parse_markdown_to_headers(s["md_content"])
            total_lines = len(s["md_content"].splitlines())
        else:
            from ..pipeline.tree.builder import FlatHeader
            md_lines = s["md_content"].splitlines()
            page_line_index: dict[int, int] = {}
            for i, line in enumerate(md_lines):
                if line.startswith("## Page "):
                    try:
                        n = int(line.split()[-1])
                        page_line_index[n] = i
                    except (ValueError, IndexError):
                        pass
            headers = []
            for nd in s["toc_nodes"]:
                start = page_line_index.get(nd["page_start"], 0)
                headers.append(FlatHeader(
                    level=nd["depth"], title=nd["title"],
                    start_line=start, text="",
                ))
            total_lines = len(md_lines)

        roots = build_tree(headers, total_lines=total_lines)
        all_nodes = list(flatten(roots))

        async with db.pool.acquire() as conn:
            async with conn.transaction():
                id_map: dict[str, str] = {}
                inserted = 0
                for n in all_nodes:
                    chunks = split_text_by_tokens(n.text or "", split_cfg)
                    if len(chunks) > 1:
                        log.info("structure.split", node=n.title, chunks=len(chunks))
                    parent_uuid = id_map.get(n.parent.node_id_str) if n.parent else None
                    new_id = await conn.fetchval(
                        """insert into tree_nodes (
                            document_id, parent_id, node_id_str, structure_code,
                            depth, title, start_index, end_index, text,
                            appear_start
                           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                           returning id""",
                        s["document_id"], parent_uuid,
                        n.node_id_str, n.structure_code, n.depth, n.title,
                        n.start_index, n.end_index, chunks[0],
                        getattr(n, "appear_start", None),
                    )
                    id_map[n.node_id_str] = str(new_id)
                    inserted += 1
                    for ci, extra in enumerate(chunks[1:], start=2):
                        await conn.execute(
                            """insert into tree_nodes (
                                document_id, parent_id, node_id_str, structure_code,
                                depth, title, start_index, end_index, text
                               ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)""",
                            s["document_id"], new_id,
                            f"{n.node_id_str}_part{ci}", f"{n.structure_code}.{ci}",
                            n.depth + 1, f"{n.title} (part {ci})",
                            n.start_index, n.end_index, extra,
                        )
                        inserted += 1
                await conn.execute(
                    """update documents set
                         page_count=$2, parser_used=$3, path_used=$4,
                         doc_summary_short=$5
                       where id=$1""",
                    s["document_id"], s.get("page_count"),
                    s.get("parser_used"), s.get("path_used"),
                    s.get("doc_summary_short"),
                )
        return {"node_count": inserted}

    async def mark_summarizing(s: State) -> dict:
        async with db.pool.acquire() as conn:
            await conn.execute(
                "update documents set status='summarizing' where id=$1",
                s["document_id"],
            )
        return {}

    g = StateGraph(State)
    g.add_node("load_document", load_document)
    g.add_node("parse_markdown_path", parse_markdown_path)
    g.add_node("parse_pdf_path", parse_pdf_path)
    g.add_node("detect_and_extract_toc", detect_and_extract_toc)
    g.add_node("validate_and_repair", validate_and_repair)
    g.add_node("persist_tree", persist_tree)
    g.add_node("mark_summarizing", mark_summarizing)

    g.add_edge(START, "load_document")
    g.add_conditional_edges("load_document", route_after_load, {
        "markdown": "parse_markdown_path",
        "pdf": "parse_pdf_path",
    })
    g.add_edge("parse_markdown_path", "persist_tree")
    g.add_edge("parse_pdf_path", "detect_and_extract_toc")
    g.add_edge("detect_and_extract_toc", "validate_and_repair")
    g.add_edge("validate_and_repair", "persist_tree")
    g.add_edge("persist_tree", "mark_summarizing")
    g.add_edge("mark_summarizing", END)
    return g.compile(checkpointer=checkpointer)


async def run_structure(graph, *, document_id: str) -> dict:
    config = {"configurable": {"thread_id": f"structure:{document_id}"}}
    final = await graph.ainvoke({"document_id": document_id}, config=config)
    return {"node_count": final.get("node_count", 0), "aborted": final.get("aborted", False)}
