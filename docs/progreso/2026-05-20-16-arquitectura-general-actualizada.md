# Arquitectura general actualizada

Estado: actualizado.

## Hecho

Se reescribio `docs/arquitectura.md` para alinearlo con la decision vigente.

## Cambios principales

- Supabase Storage queda como storage inicial de documentos.
- Cloudflare R2 queda como upgrade futuro si el costo/egress lo pide.
- SDA Tree Index reemplaza a PageIndex como arquitectura central.
- MinerU queda como extractor fiel.
- LangGraph + LLM estructural quedan como constructor/verificador del arbol.
- Inngest orquesta el workflow durable.
- `srv-ia-01` queda definido como SDA Compute Gateway.
- Live-first queda como principio de producto: Realtime, SSE, timelines y
  eventos visibles.

## Siguiente corte

- Crear `indexing_runs` e `indexing_events`.
- Mostrar timeline live en detalle de documento.
- Crear skeleton Inngest + Compute Gateway.
