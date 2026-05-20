# OpenRouter Gemini Tree Index real

Estado: verificado end-to-end en `srv-ia-01` con persistencia real.

## Configuracion

- Provider: OpenRouter.
- Modelo: `google/gemini-3.5-flash`.
- Provider order: `google-vertex/global`.
- Service tier: default de OpenRouter. En config se deja
  `SDA_TREE_LLM_SERVICE_TIER=` para omitir el campo; OpenRouter respondio
  `standard` en la llamada minima validada.
- Fallbacks: deshabilitados.
- Reasoning: `low` y excluido de respuesta.
- No se configura `max_tokens` bajo para construccion de arbol.

## Que se hizo

- Se actualizo la API key de OpenRouter en el `.env` remoto del Tree Indexer.
- Se valido una llamada minima a OpenRouter con:
  - modelo `google/gemini-3.5-flash`;
  - provider `google-vertex/global`;
  - sin `service_tier` explicito.
- Se agrego soporte para provider routing, service tier y reasoning config en:
  - worker Python;
  - cliente TypeScript heredado.
- Se agrego persistencia directa desde Python a:
  - `doc_tree`;
  - `chunks`.
- Inngest fue actualizado para crear y observar jobs del Tree Indexer Python a
  traves del Compute Gateway, en vez de construir el arbol dentro de Vercel.

## Verificacion

Smoke real sobre la extraccion MinerU existente, ya usando el perfil default:

- Documento: `2e1c2b6b-e608-461a-aab7-1f4c4c34f408`.
- Extraccion: `63d9abe4-93d1-4471-bcfa-4466f0eba9ce`.
- `artifact_count`: 49.
- `page_count`: 12.
- `status`: `succeeded`.
- `stage`: `tree_indexed`.
- `chunk_count`: 11.
- `doc_tree_count`: 1.
- `chunks` persistidos en Supabase: 11.

Luego se hizo una segunda corrida de calidad sobre el mismo PDF para comparar
paginas MinerU contra el arbol generado:

- Job: `7ec85fc7-f6a3-40e4-9e0e-328f8c887b00`.
- `page_count`: 12.
- `chunk_count`: 11.
- Resultado: los titulos y la jerarquia quedaron alineados con el PDF.
- Se corrigio contaminacion de rangos causada por logos/headers repetidos al
  inicio de pagina.
- La pagina 12 esta vacia y queda fuera del ultimo rango.

## Gotchas

- Una API key invalida de OpenRouter devolvio `401 User not found`; el provider
  y el modelo estaban bien.
- Un `max_tokens` muy bajo puede cortar la respuesta antes de que Gemini emita
  `content`, porque puede gastar tokens iniciales en reasoning. No usar caps
  bajos para arboles.
- Si el PDF repite logo/marca/header antes del titulo real, el verificador LLM
  puede no marcar `appear_start=yes`. El worker ahora aplica tambien una regla
  deterministica: si el titulo aparece cerca del inicio de la pagina, esa pagina
  se considera inicio de seccion.

## Pendiente

1. Agregar embeddings jerarquicos sobre `chunks`.
2. Separar mejor el tratamiento de chunks padre si queremos evitar duplicacion
   entre un nodo padre y su primer hijo.
