"""Extrae ground truth TOC de cada PDF del corpus para review humano.

Para cada PDF:
1. Lo descarga (vía fixture)
2. Manda al servicio mineru → markdown
3. Hace UN prompt verboso a DeepSeek: "extract every section heading with page"
4. Output YAML por PDF — Enzo lo revisa y corrige en ~30min total

NO es lo mismo que el pipeline — esto es referencia independiente para
calcular F1 score en D-1.3.

Uso:
  cd services/sda-indexer
  DEEPSEEK_API_KEY=... MINERU_URL=... MINERU_SHARED_SECRET=... \
    uv run python scripts/extract_ground_truth.py
"""

import asyncio
import hashlib
import json
import os
from pathlib import Path

import httpx
import yaml
from openai import AsyncOpenAI


CORPUS_MANIFEST = Path(__file__).parent.parent / "tests/fixtures/pdf_corpus.yaml"
OUTPUT = Path(__file__).parent.parent / "tests/fixtures/ground_truth_tocs.yaml"
CACHE = Path("~/.cache/sda-test-corpus").expanduser()


GROUND_TRUTH_PROMPT = """\
Identify EVERY section heading in this document. Be exhaustive — don't skip
appendices, indices, or sub-sub-sections.

For each heading return:
- title: cleaned (no leaders/page numbers)
- depth: 1=top, 2=sub, 3=sub-sub...
- page_start: page where heading appears (1-indexed)

Output strict JSON object {"headings": [...]}. No prose.
"""


async def upload_to_supabase_and_signed_url(local_path: Path) -> tuple[str, str]:
    """Sube a Supabase Storage tmp + devuelve (signed_url, sha).

    Adaptar al setup local — o pasar URL pública directa al PDF.
    """
    raise NotImplementedError("Adaptar a tu fixture de upload — o pasar URL pública directa")


async def call_mineru(signed_url: str, sha: str, doc_id: str) -> str:
    url = os.environ["MINERU_URL"]
    secret = os.environ["MINERU_SHARED_SECRET"]
    async with httpx.AsyncClient(timeout=600) as c:
        r = await c.post(
            f"{url}/parse",
            headers={"Authorization": f"Bearer {secret}"},
            json={"doc_id": doc_id, "signed_url": signed_url, "expected_sha256": sha},
        )
        r.raise_for_status()
        return r.json()["markdown"]


async def call_llm_for_headings(client: AsyncOpenAI, markdown: str) -> list[dict]:
    body = markdown[:50_000]  # cap a 50k chars para 1 call
    resp = await client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": "You are a careful document structure analyzer."},
            {"role": "user", "content": f"{GROUND_TRUTH_PROMPT}\n\n{body}"},
        ],
        temperature=0.0,
        response_format={"type": "json_object"},
        max_tokens=4096,
    )
    data = json.loads(resp.choices[0].message.content)
    return data.get("headings", [])


async def main():
    manifest = yaml.safe_load(CORPUS_MANIFEST.read_text())
    client = AsyncOpenAI(
        api_key=os.environ["DEEPSEEK_API_KEY"],
        base_url="https://api.deepseek.com/v1",
    )
    out: dict[str, list[dict]] = {}
    for entry in manifest["pdfs"]:
        if entry["url"].startswith("REEMPLAZAR"):
            print(f"skip {entry['id']} (URL no anotada)")
            continue
        local = CACHE / f"{entry['id']}.pdf"
        if not local.exists():
            print(f"  fetching {entry['id']}")
            r = httpx.get(entry["url"], timeout=120, follow_redirects=True)
            local.write_bytes(r.content)
        sha = hashlib.sha256(local.read_bytes()).hexdigest()
        print(f"processing {entry['id']} ({sha[:12]}...)")
        signed_url, _ = await upload_to_supabase_and_signed_url(local)
        markdown = await call_mineru(signed_url, sha, entry["id"])
        headings = await call_llm_for_headings(client, markdown)
        out[entry["id"]] = headings
        print(f"  → {len(headings)} headings")

    OUTPUT.write_text(yaml.safe_dump(out, sort_keys=False, allow_unicode=True))
    print(f"\nWrote {OUTPUT} — review/correct manually, then commit.")


if __name__ == "__main__":
    asyncio.run(main())
