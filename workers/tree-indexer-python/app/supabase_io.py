from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import httpx


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
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.get(
            f"{url}/rest/v1/document_extraction_artifacts",
            headers=_headers(key),
            params=params,
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
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.get(
            f"{url}/storage/v1/object/{encoded_bucket}/{encoded_path}",
            headers=_headers(key),
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
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.delete(
            f"{url}/rest/v1/chunks",
            headers=_json_headers(key, "return=minimal"),
            params=params,
        )
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase chunks delete fallo {response.status_code}: {response.text}")


async def upsert_document_tree(row: dict[str, Any]) -> None:
    url, key = _supabase_config()
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            f"{url}/rest/v1/doc_tree",
            headers=_json_headers(key, "resolution=merge-duplicates,return=minimal"),
            json=row,
            params={"on_conflict": "document_id"},
        )
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase doc_tree upsert fallo {response.status_code}: {response.text}")


async def insert_chunks(rows: list[dict[str, Any]], batch_size: int = 500) -> None:
    if not rows:
        raise RuntimeError("Tree Indexer no genero chunks/nodos recuperables.")

    url, key = _supabase_config()
    async with httpx.AsyncClient(timeout=120) as client:
        for start in range(0, len(rows), batch_size):
            batch = rows[start : start + batch_size]
            response = await client.post(
                f"{url}/rest/v1/chunks",
                headers=_json_headers(key, "return=minimal"),
                json=batch,
            )
            if response.status_code >= 400:
                raise RuntimeError(
                    f"Supabase chunks insert fallo {response.status_code}: {response.text}"
                )


async def persist_tree_index(
    *,
    document_id: str,
    extraction_id: str,
    result: dict[str, Any],
    run_id: str,
    tenant_id: str,
) -> dict[str, Any]:
    await delete_document_chunks(tenant_id=tenant_id, document_id=document_id)
    await upsert_document_tree(
        {
            "document_id": document_id,
            "metadata": {
                "embedding_status": "pending",
                "extraction_id": extraction_id,
                "indexer": result["version"],
                "metrics": result["metrics"],
                "run_id": run_id,
                "source": "pageindex_style_python_llm_tree",
            },
            "model": result["model"],
            "summary": result["doc_summary"],
            "tenant_id": tenant_id,
            "tree": {
                "nodes": result["tree_for_storage"],
                "source": "pageindex_style_python_llm_tree",
                "version": result["version"],
            },
            "version": result["version"],
        }
    )

    rows = [
        {
            "chunk_index": chunk["chunk_index"],
            "content": chunk["content"],
            "document_id": document_id,
            "metadata": {
                **chunk["metadata"],
                "extraction_id": extraction_id,
                "indexer": result["version"],
                "run_id": run_id,
            },
            "node_id": chunk["node_id"],
            "node_path": chunk["node_path"],
            "page_end": chunk["page_end"],
            "page_start": chunk["page_start"],
            "summary": chunk.get("summary"),
            "tenant_id": tenant_id,
            "token_count": chunk["token_count"],
        }
        for chunk in result["chunks"]
    ]
    await insert_chunks(rows)

    return {
        "chunk_count": len(rows),
        "document_id": document_id,
        "extraction_id": extraction_id,
        "run_id": run_id,
        "tenant_id": tenant_id,
    }
