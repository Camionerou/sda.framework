# PageIndex worker vendoreado

Estado: superseded y removido del codigo activo.

Este experimento quedo desplazado por la decision de construir `SDA Tree
Indexer` propio con MinerU + LangGraph + Inngest. PageIndex queda como
referencia conceptual, no como dependencia central.

El codigo vendoreado de `workers/pageindex` no se conserva en el proyecto para
evitar deuda tecnica en el primer push a GitHub.

## Se habia probado

- Se copio la implementacion open-source de PageIndex en:

```text
workers/pageindex/upstream
```

- Se preservo el codigo upstream separado de la capa propia.
- Se agrego wrapper local:

```text
workers/pageindex/index_document.py
```

- El wrapper usa PageIndex para construir el arbol y no define un splitter propio.
- El output exacto de PageIndex se guarda en `doc_tree.tree`.
- Los registros de `chunks` se generan a partir de los nodos PageIndex, sin
  volver a partir el texto.

## Decision

Por defecto usamos:

```text
PAGEINDEX_CHUNK_SCOPE=all
```

Eso significa que cada nodo PageIndex se persiste como chunk. Es el modo mas
fiel a PageIndex porque conserva nodos padre, hijos, resumen, rango de paginas
y path jerarquico.

Si mas adelante hay duplicacion excesiva para embeddings, podemos cambiar a:

```text
PAGEINDEX_CHUNK_SCOPE=leaf
```

pero no es el default.

## Archivos del experimento removido

- `workers/pageindex/upstream/pageindex/`
- `workers/pageindex/upstream/run_pageindex.py`
- `workers/pageindex/upstream/requirements.txt`
- `workers/pageindex/upstream/LICENSE`
- `workers/pageindex/UPSTREAM.md`
- `workers/pageindex/README.md`
- `workers/pageindex/requirements.txt`
- `workers/pageindex/index_document.py`

## Pendiente

- No continuar este camino salvo que se necesite PageIndex como referencia de
  comportamiento.
