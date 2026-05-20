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

