> **STATUS: PENDING EXECUTION.** El script `services/sda-indexer/scripts/verify_deepseek_cache.py` fue creado pero NO ejecutado durante la implementación de Task 6 (no DEEPSEEK_API_KEY disponible en el entorno del implementer). Ejecutar manualmente con `DEEPSEEK_API_KEY=... uv run python scripts/verify_deepseek_cache.py` y completar la tabla de Results + Verdict abajo. Sólo proceder con Task 16 (cache_design.py) si verdict es OK.

# DeepSeek prompt cache — empirical verification

**Date:** 2026-05-25
**Spec ref:** [2026-05-25 wave 1 §3.4](../specs/2026-05-25-ingest-index-wave-1-design.md)

## Setup
- Model: deepseek-chat
- Static prompt zone: ~XXXX tokens
- Endpoint: https://api.deepseek.com/v1

## Results

| Call # | prompt_tokens | cached_tokens | hit_ratio |
|---|---|---|---|
| 1 (cold) | X | 0 | 0% |
| 2 | X | Y | Z% |
| 3 | X | Y | Z% |
| 4 (after 60s) | X | Y | Z% |

## Field name in API
- Field path observed: `usage.prompt_tokens_details.cached_tokens`

## Verdict
- [ ] Cache funciona como esperamos
- [ ] TTL > 30min (estimado)
- [ ] Threshold mínimo de prompt confirmado: ~1024 toks

## Action items
- [ ] Si verdict OK → proceder con cache_design.py (Task 16)
- [ ] Si verdict FALLA → escalar al usuario antes de seguir
