# OpenRouter Gemini Tree Index real

Estado: verificado end-to-end en `srv-ia-01` con persistencia real.

## Configuracion

- Provider: OpenRouter.
- Modelo: `google/gemini-3.5-flash`.
- Provider order: `google-vertex/global`.
- Service tier: `flex`.
- Fallbacks: deshabilitados.
- Reasoning: `low` y excluido de respuesta.
- No se configura `max_tokens` bajo para construccion de arbol.

## Que se hizo

- Se actualizo la API key de OpenRouter en el `.env` remoto del Tree Indexer.
- Se valido una llamada minima a OpenRouter con:
  - modelo `google/gemini-3.5-flash`;
  - provider `google-vertex/global`;
  - `service_tier=flex`.
- Se agrego soporte para provider routing, service tier y reasoning config en:
  - worker Python;
  - cliente TypeScript heredado.
- Se agrego persistencia directa desde Python a:
  - `doc_tree`;
  - `chunks`.
- Inngest fue actualizado para crear y observar jobs del Tree Indexer Python a
  traves del Compute Gateway, en vez de construir el arbol dentro de Vercel.

## Verificacion

Smoke real sobre la extraccion MinerU existente:

- Documento: `2e1c2b6b-e608-461a-aab7-1f4c4c34f408`.
- Extraccion: `63d9abe4-93d1-4471-bcfa-4466f0eba9ce`.
- `artifact_count`: 49.
- `page_count`: 12.
- `status`: `succeeded`.
- `stage`: `tree_indexed`.
- `chunk_count`: 11.
- `doc_tree_count`: 1.
- `chunks` persistidos en Supabase: 11.

## Gotchas

- Una API key invalida de OpenRouter devolvio `401 User not found`; el provider
  y el modelo estaban bien.
- Un `max_tokens` muy bajo puede cortar la respuesta antes de que Gemini emita
  `content`, porque puede gastar tokens iniciales en reasoning. No usar caps
  bajos para arboles.

## Pendiente

1. Pushear y desplegar la app para que Inngest use el Tree Indexer Python.
2. Ejecutar una corrida desde la UI/Inngest completa.
3. Agregar embeddings jerarquicos sobre `chunks`.
