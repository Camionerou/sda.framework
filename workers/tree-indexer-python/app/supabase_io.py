from __future__ import annotations

import hashlib
import os
import re
import uuid
from typing import Any
from urllib.parse import quote

from .http_client import get_supabase_client
from .versions import INDEXING_VERSION_COLUMNS, TREE_PROMPT_VERSION, version_value
from .pageindex_style import SOURCE_BLOCKS_COORDINATE_SYSTEM


class SupabaseConfigError(RuntimeError):
    pass


def _supabase_config() -> tuple[str, str]:
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SECRET_KEY")
    if not url or not key:
        raise SupabaseConfigError("SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridos.")
    return url, key


def _headers(key: str) -> dict[str, str]:
    return {
        "apikey": key,
        "authorization": f"Bearer {key}",
    }


def _json_headers(key: str, prefer: str | None = None) -> dict[str, str]:
    headers = {
        **_headers(key),
        "content-type": "application/json",
    }
    if prefer:
        headers["prefer"] = prefer
    return headers


def _stable_node_uuid(*, tenant_id: str, document_id: str, node_id: str) -> str:
    digest = hashlib.md5(f"{tenant_id}:{document_id}:{node_id}".encode("utf-8")).hexdigest()
    return str(uuid.UUID(digest))


def _ltree_label(value: Any) -> str:
    label = re.sub(r"[^a-z0-9_]+", "_", str(value).lower()) or "node"
    return f"n{label}"[:240]


def _node_page(value: Any, field: str) -> int:
    if isinstance(value, int):
        page = value
    elif isinstance(value, str) and value.isdigit():
        page = int(value)
    else:
        raise RuntimeError(f"Tree node invalido: {field} debe ser entero.")

    if page < 1:
        raise RuntimeError(f"Tree node invalido: {field} debe ser mayor a 0.")
    return page


def _doc_tree_node_rows(
    *,
    chunks: list[dict[str, Any]],
    document_id: str,
    document_type: str,
    embedding_pipeline_version: str,
    indexing_pipeline_version: str,
    nodes: list[dict[str, Any]],
    tenant_id: str,
    tree_indexer_version: str,
    tree_prompt_version: str,
) -> list[dict[str, Any]]:
    chunks_by_node_id = {
        str(chunk["node_id"]): chunk
        for chunk in chunks
        if chunk.get("node_id") is not None
    }
    rows: list[dict[str, Any]] = []

    def visit(
        node: dict[str, Any],
        *,
        depth: int,
        ordinal_path: list[int],
        parent_id: str | None,
        parent_path: list[str],
    ) -> None:
        node_id = str(node.get("node_id") or ".".join(str(part) for part in ordinal_path))
        children = node.get("nodes") if isinstance(node.get("nodes"), list) else []
        chunk = chunks_by_node_id.get(node_id, {})
        page_start = _node_page(node.get("start_index"), "start_index")
        page_end = _node_page(node.get("end_index"), "end_index")

        if page_end < page_start:
            raise RuntimeError("Tree node invalido: end_index debe ser mayor o igual a start_index.")

        metadata = dict(chunk.get("metadata") or {})
        metadata.update(
            {
                "document_type": document_type,
                "page_range": [page_start, page_end],
                "source": "pageindex_style_python_tree",
            }
        )
        if node.get("source_blocks"):
            metadata["source_blocks"] = node["source_blocks"]
            metadata["source_blocks_coordinate_system"] = SOURCE_BLOCKS_COORDINATE_SYSTEM
        if "confidence" in node:
            metadata["confidence"] = node["confidence"]

        row_id = _stable_node_uuid(
            tenant_id=tenant_id,
            document_id=document_id,
            node_id=node_id,
        )
        node_path = [*parent_path, _ltree_label(node_id)]

        rows.append(
            {
                "document_id": document_id,
                "embedding": chunk.get("embedding"),
                "embedding_model": chunk.get("embedding_model"),
                "embedding_pipeline_version": embedding_pipeline_version,
                "id": row_id,
                "indexing_pipeline_version": indexing_pipeline_version,
                "metadata": metadata,
                "node_id": node_id,
                "node_path": ".".join(node_path),
                "node_type": "root" if depth == 0 else "section" if children else "leaf",
                "page_end": page_end,
                "page_start": page_start,
                "parent_id": parent_id,
                "routing_summary": node.get("routing_summary"),
                "summary": node.get("summary"),
                "tenant_id": tenant_id,
                "title": str(node.get("title") or "Untitled section"),
                "tree_indexer_version": tree_indexer_version,
                "tree_prompt_version": tree_prompt_version,
            }
        )

        for index, child in enumerate(children):
            if isinstance(child, dict):
                visit(
                    child,
                    depth=depth + 1,
                    ordinal_path=[*ordinal_path, index],
                    parent_id=row_id,
                    parent_path=node_path,
                )

    for index, node in enumerate(nodes):
        visit(
            node,
            depth=0,
            ordinal_path=[index],
            parent_id=None,
            parent_path=[],
        )

    return rows


async def list_extraction_artifacts(
    *,
    tenant_id: str,
    document_id: str,
    extraction_id: str,
) -> list[dict[str, Any]]:
    url, key = _supabase_config()
    params = {
        "document_id": f"eq.{document_id}",
        "extraction_id": f"eq.{extraction_id}",
        "select": "artifact_type,storage_bucket,storage_path,byte_size,content_type,metadata",
        "tenant_id": f"eq.{tenant_id}",
    }
    client = get_supabase_client()
    response = await client.get(
        f"{url}/rest/v1/document_extraction_artifacts",
        headers=_headers(key),
        params=params,
        timeout=60,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase artifact query fallo {response.status_code}: {response.text}")
    data = response.json()
    if not isinstance(data, list):
        raise RuntimeError("Supabase artifact query devolvio una respuesta invalida.")
    return data


async def download_storage_json(bucket: str, path: str) -> Any:
    url, key = _supabase_config()
    encoded_bucket = quote(bucket, safe="")
    encoded_path = "/".join(quote(part, safe="") for part in path.split("/"))
    client = get_supabase_client()
    response = await client.get(
        f"{url}/storage/v1/object/{encoded_bucket}/{encoded_path}",
        headers=_headers(key),
        timeout=120,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase Storage download fallo {response.status_code}: {response.text}")
    return response.json()


async def delete_document_chunks(*, tenant_id: str, document_id: str) -> None:
    url, key = _supabase_config()
    params = {
        "document_id": f"eq.{document_id}",
        "tenant_id": f"eq.{tenant_id}",
    }
    client = get_supabase_client()
    response = await client.delete(
        f"{url}/rest/v1/chunks",
        headers=_json_headers(key, "return=minimal"),
        params=params,
        timeout=60,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase chunks delete fallo {response.status_code}: {response.text}")


async def delete_document_tree_nodes(*, tenant_id: str, document_id: str) -> None:
    url, key = _supabase_config()
    params = {
        "document_id": f"eq.{document_id}",
        "tenant_id": f"eq.{tenant_id}",
    }
    client = get_supabase_client()
    response = await client.delete(
        f"{url}/rest/v1/doc_tree_nodes",
        headers=_json_headers(key, "return=minimal"),
        params=params,
        timeout=60,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase doc_tree_nodes delete fallo {response.status_code}: {response.text}")


async def upsert_document_tree(row: dict[str, Any]) -> None:
    url, key = _supabase_config()
    client = get_supabase_client()
    response = await client.post(
        f"{url}/rest/v1/doc_tree",
        headers=_json_headers(key, "resolution=merge-duplicates,return=minimal"),
        json=row,
        params={"on_conflict": "document_id"},
        timeout=60,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase doc_tree upsert fallo {response.status_code}: {response.text}")


async def document_metadata(*, tenant_id: str, document_id: str) -> dict[str, Any]:
    url, key = _supabase_config()
    params = {
        "id": f"eq.{document_id}",
        "select": "metadata",
        "tenant_id": f"eq.{tenant_id}",
    }
    client = get_supabase_client()
    response = await client.get(
        f"{url}/rest/v1/documents",
        headers=_headers(key),
        params=params,
        timeout=60,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase document metadata query fallo {response.status_code}: {response.text}")
    data = response.json()
    if not isinstance(data, list) or not data:
        return {}
    metadata = data[0].get("metadata")
    return metadata if isinstance(metadata, dict) else {}


async def update_document_metadata(
    *,
    document_id: str,
    metadata: dict[str, Any],
    tenant_id: str,
) -> None:
    url, key = _supabase_config()
    params = {
        "id": f"eq.{document_id}",
        "tenant_id": f"eq.{tenant_id}",
    }
    client = get_supabase_client()
    response = await client.patch(
        f"{url}/rest/v1/documents",
        headers=_json_headers(key, "return=minimal"),
        json={"metadata": metadata},
        params=params,
        timeout=60,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase document metadata update fallo {response.status_code}: {response.text}")


async def insert_chunks(rows: list[dict[str, Any]], batch_size: int = 500) -> None:
    if not rows:
        raise RuntimeError("Tree Indexer no genero chunks/nodos recuperables.")

    url, key = _supabase_config()
    client = get_supabase_client()
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        response = await client.post(
            f"{url}/rest/v1/chunks",
            headers=_json_headers(key, "return=minimal"),
            json=batch,
            timeout=120,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase chunks insert fallo {response.status_code}: {response.text}"
            )


async def insert_document_tree_nodes(rows: list[dict[str, Any]], batch_size: int = 500) -> None:
    if not rows:
        raise RuntimeError("Tree Indexer no genero doc_tree_nodes recuperables.")

    url, key = _supabase_config()
    client = get_supabase_client()
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        response = await client.post(
            f"{url}/rest/v1/doc_tree_nodes",
            headers=_json_headers(key, "return=minimal"),
            json=batch,
            timeout=120,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase doc_tree_nodes insert fallo {response.status_code}: {response.text}"
            )


async def persist_tree_index(
    *,
    document_id: str,
    extraction_id: str,
    result: dict[str, Any],
    run_id: str,
    tenant_id: str,
    versions: dict[str, str] | None = None,
) -> dict[str, Any]:
    indexing_pipeline_version = version_value(
        versions,
        "indexing_pipeline_version",
        INDEXING_VERSION_COLUMNS["indexing_pipeline_version"],
    )
    tree_indexer_version = version_value(
        versions,
        "tree_indexer_version",
        INDEXING_VERSION_COLUMNS["tree_indexer_version"],
    )
    embedding_pipeline_version = version_value(
        versions,
        "embedding_pipeline_version",
        INDEXING_VERSION_COLUMNS["embedding_pipeline_version"],
    )
    tree_prompt_version = version_value(versions, "tree_prompt_version", TREE_PROMPT_VERSION)
    document_type = result.get("document_type") or "other"
    embedding_count = int(result["metrics"].get("embedding_count") or 0)
    embedding_model = result["metrics"].get("embedding_model")
    embedding_status = "completed" if embedding_count > 0 else "pending"

    await delete_document_chunks(tenant_id=tenant_id, document_id=document_id)
    await delete_document_tree_nodes(tenant_id=tenant_id, document_id=document_id)
    current_metadata = await document_metadata(tenant_id=tenant_id, document_id=document_id)
    await update_document_metadata(
        document_id=document_id,
        metadata={
            **current_metadata,
            "document_type": document_type,
            "embedding_count": embedding_count,
            "embedding_model": embedding_model,
            "embedding_status": embedding_status,
        },
        tenant_id=tenant_id,
    )
    await upsert_document_tree(
        {
            "document_id": document_id,
            "indexing_pipeline_version": indexing_pipeline_version,
            "metadata": {
                "embedding_count": embedding_count,
                "embedding_model": embedding_model,
                "embedding_status": embedding_status,
                "extraction_id": extraction_id,
                "indexer": result["version"],
                "metrics": result["metrics"],
                "document_type": document_type,
                "run_id": run_id,
                "source": "pageindex_style_python_llm_tree",
                "versions": versions or {},
            },
            "model": result["model"],
            "routing_summary": result.get("routing_summary"),
            "summary": result["doc_summary"],
            "tenant_id": tenant_id,
            "tree": {
                "nodes": result["tree_for_storage"],
                "document_type": document_type,
                "source": "pageindex_style_python_llm_tree",
                "source_blocks_coordinate_system": result.get("source_blocks_coordinate_system"),
                "version": result["version"],
            },
            "tree_indexer_version": tree_indexer_version,
            "tree_prompt_version": tree_prompt_version,
            "version": result["version"],
        }
    )

    rows = [
        {
            "chunk_index": chunk["chunk_index"],
            "content": chunk["content"],
            "document_id": document_id,
            "embedding": chunk.get("embedding"),
            "embedding_model": chunk.get("embedding_model"),
            "embedding_pipeline_version": embedding_pipeline_version,
            "indexing_pipeline_version": indexing_pipeline_version,
            "metadata": {
                **chunk["metadata"],
                "document_type": document_type,
                "extraction_id": extraction_id,
                "indexer": result["version"],
                "run_id": run_id,
                "versions": versions or {},
            },
            "node_id": chunk["node_id"],
            "node_path": chunk["node_path"],
            "page_end": chunk["page_end"],
            "page_start": chunk["page_start"],
            "routing_summary": chunk.get("routing_summary"),
            "summary": chunk.get("summary"),
            "tenant_id": tenant_id,
            "tree_indexer_version": tree_indexer_version,
            "token_count": chunk["token_count"],
        }
        for chunk in result["chunks"]
    ]
    node_rows = _doc_tree_node_rows(
        chunks=rows,
        document_id=document_id,
        document_type=document_type,
        embedding_pipeline_version=embedding_pipeline_version,
        indexing_pipeline_version=indexing_pipeline_version,
        nodes=result["tree_for_storage"],
        tenant_id=tenant_id,
        tree_indexer_version=tree_indexer_version,
        tree_prompt_version=tree_prompt_version,
    )
    await insert_chunks(rows)
    await insert_document_tree_nodes(node_rows)

    return {
        "chunk_count": len(rows),
        "document_id": document_id,
        "extraction_id": extraction_id,
        "indexing_pipeline_version": indexing_pipeline_version,
        "node_count": len(node_rows),
        "run_id": run_id,
        "tenant_id": tenant_id,
        "tree_indexer_version": tree_indexer_version,
    }
