"""Stress test: 50 papers random de arXiv. Valida D-1.4 / D-1.5 sobre N>>1.

NO usa pytest — script standalone con CSV + report.md output.

Uso:
  cd services/sda-indexer
  uv run python tests/stress/run_arxiv_sample.py --sample-size 50
"""

import argparse
import asyncio
import csv
import re
import time
import uuid
from datetime import datetime
from pathlib import Path

import httpx


ARXIV_API = "http://export.arxiv.org/api/query"
RESULTS_DIR = Path(__file__).parent / "results"


def _arxiv_search(category: str = "cs.AI", max_results: int = 50, sortby: str = "submittedDate") -> list[dict]:
    """Devuelve lista de {id, title, pdf_url} via arXiv API."""
    params = {
        "search_query": f"cat:{category}",
        "max_results": max_results,
        "sortBy": sortby,
        "sortOrder": "descending",
    }
    r = httpx.get(ARXIV_API, params=params, timeout=60)
    r.raise_for_status()
    entries = re.findall(
        r"<entry>.*?<id>(.*?)</id>.*?<title>(.*?)</title>.*?<link.*?pdf.*?href=\"(.*?)\".*?</entry>",
        r.text,
        re.DOTALL,
    )
    return [{"id": e[0], "title": e[1].strip(), "pdf_url": e[2]} for e in entries]


async def _process(env, paper: dict) -> dict:
    """Upload paper a Supabase Storage + enqueue + wait + measure."""
    from tests.e2e.test_canonical_corpus import (
        _upload_and_enqueue, _wait_for_ready, _measure,
    )
    doc_id = str(uuid.uuid4())
    tmp = Path(f"/tmp/{doc_id}.pdf")
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as c:
        r = await c.get(paper["pdf_url"])
        tmp.write_bytes(r.content)
    try:
        await _upload_and_enqueue(env, tmp, doc_id)
        await _wait_for_ready(env, doc_id, timeout=900)
        metrics = await _measure(env, doc_id)
        return {**metrics, "paper_id": paper["id"], "doc_id": doc_id, "status": "ok"}
    except Exception as e:
        return {"paper_id": paper["id"], "doc_id": doc_id, "status": "failed", "error": str(e)}
    finally:
        tmp.unlink(missing_ok=True)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-size", type=int, default=50)
    parser.add_argument("--category", default="cs.AI")
    parser.add_argument("--concurrency", type=int, default=5)
    args = parser.parse_args()

    import os
    env = {k: os.environ[k] for k in [
        "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "POSTGRES_URL",
    ]}

    papers = _arxiv_search(category=args.category, max_results=args.sample_size)
    print(f"Found {len(papers)} papers")

    sem = asyncio.Semaphore(args.concurrency)

    async def bounded(p):
        async with sem:
            return await _process(env, p)

    t0 = time.monotonic()
    rows = await asyncio.gather(*[bounded(p) for p in papers])
    elapsed = time.monotonic() - t0

    RESULTS_DIR.mkdir(exist_ok=True)
    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
    csv_path = RESULTS_DIR / f"{ts}.csv"
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=sorted({k for r in rows for k in r.keys()}))
        w.writeheader()
        for r in rows:
            w.writerow(r)

    ok = [r for r in rows if r["status"] == "ok"]
    avg_cost = sum(r.get("cost_cents", 0) for r in ok) / max(1, len(ok))
    avg_cache = sum(r.get("cache_hit_ratio", 0) for r in ok) / max(1, len(ok))
    report = RESULTS_DIR / f"{ts}_report.md"
    report.write_text(f"""# arXiv stress run {ts}

- Category: {args.category}
- Sample size: {args.sample_size}
- Concurrency: {args.concurrency}
- Elapsed: {elapsed:.0f}s
- Success: {len(ok)}/{len(rows)}
- Avg cost (cents/doc): {avg_cost:.2f}
- Avg cache hit ratio: {avg_cache:.2%}

CSV: `{csv_path.name}`
""")
    print(f"\nReport: {report}\nCSV: {csv_path}")


if __name__ == "__main__":
    asyncio.run(main())
