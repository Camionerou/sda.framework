# LangGraph Tree Indexer real

Estado: implementado en primer corte, pendiente de configurar provider LLM para
ejecucion end-to-end real.

## Que se hizo

- Se agrego `@langchain/langgraph`.
- Se creo `lib/tree-indexer`.
- El grafo replica el metodo PageIndex documentado:
  - paginas etiquetadas desde MinerU `content_list`;
  - LLM genera lista `{ structure, title, physical_index }`;
  - LLM verifica anchors de pagina;
  - codigo deterministico calcula `start_index/end_index` y arma arbol;
  - LLM genera summaries por nodo;
  - se persiste `doc_tree`;
  - se persisten nodos recuperables en `chunks`.
- `process-document-index` ahora continua despues de MinerU hacia Tree Indexer.
- Si falta `SDA_TREE_LLM_API_KEY` o `SDA_TREE_LLM_MODEL`, la corrida no inventa
  arbol: registra `indexing.tree.llm_missing` y deja MinerU disponible.

## Variables nuevas

```text
SDA_TREE_LLM_PROVIDER
SDA_TREE_LLM_BASE_URL
SDA_TREE_LLM_API_KEY
SDA_TREE_LLM_MODEL
SDA_TREE_SUMMARY_MODEL
SDA_TREE_LLM_TIMEOUT_MS
SDA_TREE_LLM_JSON_MODE
SDA_TREE_MAX_PROMPT_CHARS
SDA_TREE_SUMMARY_CONCURRENCY
```

## Verificacion local

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- Smoke sin LLM: el adapter de MinerU convirtio el `content_list` remoto ya
  extraido en 12 paginas etiquetadas.

## Pendiente

Configurar un provider LLM real en Vercel/Inngest y ejecutar smoke con el PDF ya
extraido para validar `doc_tree` y `chunks` en Supabase remoto.
