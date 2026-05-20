# PageIndex Tree Builder Reference

Estado: referencia de arquitectura para no volver a investigar desde cero.

Fecha de lectura: 20 de mayo de 2026.

Fuentes revisadas:

- Docs oficiales: https://docs.pageindex.ai
- Introduccion tecnica: https://pageindex.ai/research/pageindex-intro
- LLM Tree Search: https://docs.pageindex.ai/tutorials/tree-search/llm
- Hybrid Tree Search: https://docs.pageindex.ai/tutorials/tree-search/hybrid
- Repo OSS: https://github.com/VectifyAI/PageIndex
- Snapshot de codigo revisado: `VectifyAI/PageIndex@7592163e2a376b3917181fff9ac1858dc5daa2c6`

## Decision para SDA

SDA debe copiar la filosofia PageIndex: el arbol estructural candidato lo arma
un LLM. MinerU extrae evidencia fiel, pero no decide la estructura semantica
final. Las heuristicas deterministicas quedan para preparar entrada, validar
salida, calcular rangos, detectar gaps, persistir y cortar costos. No deben ser
el constructor principal del arbol.

Si no hay provider/modelo LLM configurado, el estado correcto del documento es
`structuring` pendiente o `failed` recuperable con razon clara. No se debe
persistir un arbol "fake", demo o puramente heuristico como si fuera el indice
real.

## Que hace PageIndex

PageIndex no hace RAG naive por chunks. Primero transforma el documento en un
indice jerarquico tipo Table of Contents, optimizado para que un LLM pueda
razonar sobre el documento. Luego, en retrieval, el agente mira el arbol y pide
paginas o nodos especificos.

Formato conceptual del arbol:

```json
{
  "title": "Financial Stability",
  "node_id": "0006",
  "start_index": 21,
  "end_index": 22,
  "summary": "Resumen del nodo",
  "nodes": []
}
```

`start_index` y `end_index` son paginas fisicas 1-based. `node_id` es una clave
estable para navegar y recuperar contenido crudo. `summary` existe para que el
LLM elija ramas sin recibir todo el texto del documento.

## Pipeline PageIndex observado

### 1. Entrada por paginas etiquetadas

PageIndex convierte el PDF en una lista de paginas con texto y tokens. Para el
LLM, serializa cada pagina con tags como:

```text
<physical_index_7>
contenido de la pagina
<physical_index_7>
```

En SDA, esa entrada debe salir de MinerU, no de PyPDF2. Usamos `content_list`,
markdown y artefactos de layout para construir paginas etiquetadas con la mayor
fidelidad posible.

Referencia OSS: `pageindex/utils.py#get_page_tokens` y
`pageindex/page_index.py#process_no_toc`.

### 2. Deteccion de ToC

PageIndex intenta detectar si hay tabla de contenidos. Si existe y trae numeros
de pagina, la usa como base. Si existe sin numeros, pide al LLM ubicar cada
titulo dentro de paginas etiquetadas. Si no hay ToC confiable, pasa a construir
la estructura desde el texto del documento.

Esto define tres modos:

- `process_toc_with_page_numbers`
- `process_toc_no_page_numbers`
- `process_no_toc`

Referencia OSS: `check_toc`, `process_toc_with_page_numbers`,
`process_toc_no_page_numbers`.

### 3. Generacion LLM de estructura candidata

Cuando no hay ToC usable, PageIndex le pide al LLM una lista plana jerarquica:

```json
[
  {
    "structure": "1.2.3",
    "title": "Titulo original de la seccion",
    "physical_index": "<physical_index_12>"
  }
]
```

`structure` es el codigo jerarquico. Ejemplos: `1`, `1.1`, `1.1.1`.
`title` debe salir del documento. `physical_index` indica donde empieza la
seccion.

Si el documento excede el limite de tokens, PageIndex divide paginas en grupos
con solapamiento y usa dos prompts:

- `generate_toc_init`: crea la estructura inicial.
- `generate_toc_continue`: continua la estructura usando la parte previa.

Referencia OSS: `page_index.py#generate_toc_init`,
`page_index.py#generate_toc_continue`, `page_list_to_group_text`.

### 4. Normalizacion de paginas

La salida del LLM devuelve tags de pagina. PageIndex los convierte a enteros y
rechaza indices fuera del largo real del documento.

Referencia OSS: `convert_physical_index_to_int`,
`validate_and_truncate_physical_indices`.

### 5. Verificacion con LLM

PageIndex no confia ciegamente en la primera estructura. Verifica que cada
titulo aparezca o empiece en la pagina asignada, con matching tolerante a
espacios. Si hay errores y la precision general es suficiente, intenta reparar
solo los items problematicos.

Regla observada:

- si accuracy es `1.0`, acepta;
- si accuracy es mayor a `0.6` y hay errores, repara;
- si falla, degrada de modo: ToC con paginas -> ToC sin paginas -> no ToC;
- si todo falla, aborta.

Referencia OSS: `verify_toc`, `check_title_appearance`,
`fix_incorrect_toc_with_retries`, `meta_processor`.

### 6. Conversion lista -> arbol

PageIndex calcula rangos:

- `start_index` sale del `physical_index` del nodo;
- `end_index` se calcula mirando donde empieza el siguiente nodo;
- si el siguiente titulo empieza al comienzo de su pagina, el nodo anterior
  termina en la pagina anterior;
- si no, puede terminar en la misma pagina.

Luego convierte la lista plana a arbol usando `structure`.

Referencia OSS: `utils.py#post_processing` y `utils.py#list_to_tree`.

### 7. Refinamiento recursivo

Si un nodo cubre demasiadas paginas y demasiados tokens, PageIndex vuelve a
ejecutar el extractor estructural dentro de ese rango. Este es el punto clave
contra el naive RAG: no corta por tokens, subdivide por estructura detectada.

Defaults observados en el repo:

- max paginas por nodo: `10`
- max tokens por nodo: `20000`

Referencia OSS: `process_large_node_recursively`.

### 8. Node ids, texto y summaries

Despues del arbol:

- asigna `node_id`;
- opcionalmente adjunta texto por rango de paginas;
- genera `summary` por nodo con LLM;
- opcionalmente genera descripcion del documento usando el arbol limpio.

Referencia OSS: `write_node_id`, `add_node_text`,
`generate_summaries_for_structure`, `generate_doc_description`.

## Adaptacion SDA

SDA no debe copiar PyPDF2 como extractor. Nuestro equivalente:

```text
MinerU extraction
  -> paginas etiquetadas desde content_list/markdown/layout
  -> LangGraph node: detect_toc
  -> LangGraph node: build_candidate_tree_with_llm
  -> LangGraph node: verify_page_anchors_with_llm
  -> LangGraph node: repair_or_degrade_mode
  -> LangGraph node: post_process_ranges
  -> LangGraph node: recursively_refine_large_nodes
  -> LangGraph node: summarize_nodes
  -> persist doc_tree + chunks as node/page retrieval surfaces
```

`chunks` en SDA sigue siendo una tabla de recuperacion. Puede guardar nodos,
paginas o bloques asociados al arbol, pero no representa chunks arbitrarios ni
es la fuente conceptual del indice.

## Contrato minimo para implementar

Variables de entorno esperadas:

```text
SDA_TREE_LLM_PROVIDER=openai|openrouter|anthropic|...
SDA_TREE_LLM_MODEL=<modelo fuerte para estructura>
SDA_TREE_SUMMARY_MODEL=<modelo barato/medio para summaries>
SDA_TREE_MAX_PAGES_PER_NODE=10
SDA_TREE_MAX_TOKENS_PER_NODE=20000
```

El primer corte puede usar un provider simple, pero debe llamar a un LLM real.
Si no hay secret/modelo, se registra evento live y el documento queda pendiente.

## Gotchas

- No llamar "indexado" a un documento si solo tiene MinerU persistido.
- No construir arbol real con headings heuristicas cuando falta LLM.
- No insertar texto completo en el arbol que se manda al agente en retrieval; el
  arbol debe ser liviano. El texto crudo se recupera por `node_id` o rango de
  paginas.
- Los indices de pagina son 1-based en PageIndex. MinerU usa `page_idx` 0-based;
  SDA debe convertir al persistir.
- PageIndex OSS usa parsing PDF simple; SDA usa MinerU porque necesitamos
  layout, OCR y artefactos durables.
- La validacion con LLM es parte del metodo, no un extra opcional.

