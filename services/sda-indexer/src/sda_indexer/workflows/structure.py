"""LangGraph workflow para extract_structure. Wave 0: solo MD path.
Wave 1 agrega PDF via MinerU + TOC dance."""

import hashlib
from typing import TypedDict
import structlog
from langgraph.graph import StateGraph, START, END
from ..db.client import DB
from ..db import documents, tree_nodes
from ..pipeline.parser.markdown_regex import parse_markdown_to_headers
from ..pipeline.tree.builder import build_tree, flatten

log = structlog.get_logger()


class State(TypedDict, total=False):
    document_id: str
    source_path: str
    source_type: str
    raw_bytes: bytes
    real_sha256: str
    md_content: str
    node_count: int
    aborted: bool


def build_graph(db: DB, supabase):

    async def load_from_storage(s: State) -> dict:
        doc = await documents.get_document(db.pool, s["document_id"])
        # Descarga el blob desde Storage
        resp = supabase.storage.from_("docs").download(doc["source_path"])
        raw = resp if isinstance(resp, bytes) else resp.read()
        real_sha = hashlib.sha256(raw).hexdigest()
        return {
            "raw_bytes": raw,
            "source_path": doc["source_path"],
            "source_type": doc["source_type"],
            "real_sha256": real_sha,
        }

    async def reconcile_sha(s: State) -> dict:
        result = await documents.update_sha256_post_load(
            db.pool, s["document_id"], s["real_sha256"],
        )
        if result == "duplicate":
            log.info("structure.aborted_duplicate", document_id=s["document_id"])
            return {"aborted": True}
        return {"aborted": False}

    def route_after_reconcile(s: State) -> str:
        return "done" if s.get("aborted") else "parse"

    async def parse_md(s: State) -> dict:
        if s["source_type"] != "markdown":
            raise NotImplementedError("Wave 0 sólo soporta markdown. PDF en Wave 1.")
        content = s["raw_bytes"].decode("utf-8")
        return {"md_content": content}

    async def build_tree_and_persist(s: State) -> dict:
        content = s["md_content"]
        headers = parse_markdown_to_headers(content)
        total_lines = len(content.splitlines())
        roots = build_tree(headers, total_lines=total_lines)

        # flatten + map parents
        all_nodes = list(flatten(roots))
        async with db.pool.acquire() as conn:
            async with conn.transaction():
                id_map: dict[str, str] = {}   # node_id_str → uuid
                for n in all_nodes:
                    parent_uuid = id_map.get(n.parent.node_id_str) if n.parent else None
                    new_id = await conn.fetchval(
                        """insert into tree_nodes (
                            document_id, parent_id, node_id_str, structure_code,
                            depth, title, start_index, end_index, text
                           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                           returning id""",
                        s["document_id"], parent_uuid,
                        n.node_id_str, n.structure_code, n.depth, n.title,
                        n.start_index, n.end_index, n.text,
                    )
                    id_map[n.node_id_str] = str(new_id)
        return {"node_count": len(all_nodes)}

    async def mark_summarizing(s: State) -> dict:
        async with db.pool.acquire() as conn:
            await conn.execute(
                "update documents set status='summarizing' where id=$1",
                s["document_id"],
            )
        return {}

    g = StateGraph(State)
    g.add_node("load_from_storage", load_from_storage)
    g.add_node("reconcile_sha", reconcile_sha)
    g.add_node("parse_md", parse_md)
    g.add_node("build_and_persist", build_tree_and_persist)
    g.add_node("mark_summarizing", mark_summarizing)

    g.add_edge(START, "load_from_storage")
    g.add_edge("load_from_storage", "reconcile_sha")
    g.add_conditional_edges("reconcile_sha", route_after_reconcile, {
        "parse": "parse_md",
        "done": END,
    })
    g.add_edge("parse_md", "build_and_persist")
    g.add_edge("build_and_persist", "mark_summarizing")
    g.add_edge("mark_summarizing", END)
    return g.compile()


async def run_structure(graph, *, document_id: str) -> dict:
    final = await graph.ainvoke({"document_id": document_id})
    return {"node_count": final.get("node_count", 0), "aborted": final.get("aborted", False)}
