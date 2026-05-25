"""Insert helper para llm_calls. Pull-forward Wave 2 (necesario para D-1.4/D-1.5)."""

from decimal import Decimal


# Pricing aproximado (cents per 1M tokens). Actualizar Wave 2 con pricing real.
# Defaults conservadores para deepseek-chat en 2026.
_PRICING_PER_M_TOKENS_CENTS = {
    "deepseek-chat": {"input": 14.0, "output": 28.0, "cached": 1.4},
}


def _estimate_cost_cents(model: str, tokens_in: int, tokens_out: int, cached: int) -> Decimal:
    """Calcula costo aproximado. 0 si modelo desconocido."""
    pricing = _PRICING_PER_M_TOKENS_CENTS.get(model.split("/")[-1].lower())
    if not pricing:
        return Decimal("0")
    fresh_in = max(0, tokens_in - cached)
    cost = (
        Decimal(fresh_in) * Decimal(str(pricing["input"])) / Decimal(1_000_000)
        + Decimal(cached) * Decimal(str(pricing["cached"])) / Decimal(1_000_000)
        + Decimal(tokens_out) * Decimal(str(pricing["output"])) / Decimal(1_000_000)
    )
    return cost.quantize(Decimal("0.000001"))


async def insert_llm_call(
    pool, *,
    document_id: str | None,
    node_id: str | None,
    phase: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    cached_tokens: int,
    latency_ms: int,
    success: bool,
    error_class: str | None = None,
    trace_id: str | None = None,
) -> None:
    cost = _estimate_cost_cents(model, prompt_tokens, completion_tokens, cached_tokens)
    async with pool.acquire() as conn:
        await conn.execute(
            """insert into llm_calls (
                document_id, node_id, phase, model,
                prompt_tokens, completion_tokens, cached_tokens,
                cost_cents, latency_ms, success, error_class, trace_id
              ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)""",
            document_id, node_id, phase, model,
            prompt_tokens, completion_tokens, cached_tokens,
            cost, latency_ms, success, error_class, trace_id,
        )
