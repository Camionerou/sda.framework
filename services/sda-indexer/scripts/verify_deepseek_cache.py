"""Verifica empíricamente el comportamiento de prompt caching de DeepSeek.

Quick-fail gate de Wave 1 (spec §3.4). Si DeepSeek no cachea como esperamos
(threshold ~1024 toks, TTL > 30min), re-evaluar Mejora #4 antes de invertir
en cache_design.py.

Uso:
  cd services/sda-indexer
  DEEPSEEK_API_KEY=sk-... uv run python scripts/verify_deepseek_cache.py
"""

import asyncio
import os
import time
from openai import AsyncOpenAI


# Prompt > 1024 toks de zona estática (instructions + schema verbosos).
# Repetimos un párrafo descriptivo para inflar tokens.
LARGE_SYSTEM = (
    "You are an assistant that summarizes structured data. "
    "Output strictly valid JSON matching the schema. " * 60
)
SHARED_USER_PREFIX = (
    "Given the following list of items, group them by category and "
    "report counts. " * 30
)


async def call(client: AsyncOpenAI, dynamic_suffix: str) -> dict:
    resp = await client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": LARGE_SYSTEM},
            {"role": "user", "content": SHARED_USER_PREFIX + dynamic_suffix},
        ],
        temperature=0.0,
        max_tokens=50,
    )
    usage = resp.usage
    details = getattr(usage, "prompt_tokens_details", None)
    cached = getattr(details, "cached_tokens", 0) if details else 0
    return {
        "prompt_tokens": usage.prompt_tokens,
        "cached_tokens": cached or 0,
        "completion_tokens": usage.completion_tokens,
        "model": resp.model,
    }


async def main():
    api_key = os.environ["DEEPSEEK_API_KEY"]
    # Review-fix (I6): usar /v1 para alinear con config.py + llm/client.py (Wave 0)
    client = AsyncOpenAI(api_key=api_key, base_url="https://api.deepseek.com/v1")

    print("=" * 60)
    print("DeepSeek prompt cache empirical verification")
    print("=" * 60)

    print("\n[1] First call (cold cache expected)...")
    r1 = await call(client, "Item set A: apples, oranges, bananas.")
    print(f"  prompt={r1['prompt_tokens']} cached={r1['cached_tokens']} model={r1['model']}")

    print("\n[2] Second call (same static prefix, different suffix)...")
    r2 = await call(client, "Item set B: cats, dogs, hamsters.")
    print(f"  prompt={r2['prompt_tokens']} cached={r2['cached_tokens']}")

    print("\n[3] Third call (third suffix, should also hit cache)...")
    r3 = await call(client, "Item set C: red, green, blue.")
    print(f"  prompt={r3['prompt_tokens']} cached={r3['cached_tokens']}")

    print("\n" + "=" * 60)
    print("VERDICT:")
    if r2["cached_tokens"] > 0:
        ratio = r2["cached_tokens"] / r2["prompt_tokens"]
        print(f"  ✓ Cache HIT on 2nd call ({ratio:.0%} of prompt cached)")
        print(f"  ✓ Mejora #4 viable. Proceed with cache_design.py.")
    else:
        print(f"  ✗ NO cache hit. Either prompt too short (<1024 toks),")
        print(f"    cache disabled, or API field name changed.")
        print(f"  ✗ Investigate before investing in cache_design.py.")
    print("=" * 60)

    print("\n[4] TTL test (waiting 60s, then re-call)...")
    await asyncio.sleep(60)
    r4 = await call(client, "Item set D: north, south, east.")
    print(f"  prompt={r4['prompt_tokens']} cached={r4['cached_tokens']}")
    if r4["cached_tokens"] > 0:
        print(f"  ✓ TTL > 60s")
    else:
        print(f"  ✗ Cache evicted after 60s — TTL menor a lo esperado")


if __name__ == "__main__":
    asyncio.run(main())
