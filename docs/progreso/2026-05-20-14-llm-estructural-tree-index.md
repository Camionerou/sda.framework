# LLM estructural para SDA Tree Index

Estado: documentado como requisito.

## Decision

SDA Tree Indexer requiere llamadas a LLM para construir un arbol de alta
calidad. MinerU es la primera herramienta de extraccion fiel, pero no decide por
si sola la memoria navegable del documento.

## Etapas con LLM

- Deteccion de tipo documental.
- Generacion de arbol candidato.
- Verificacion de cobertura y evidencia.
- Refinamiento recursivo de nodos grandes o inciertos.
- Generacion de `summary`.
- Generacion de `routing_summary`.

## Politica de costo/calidad

- Modelo fuerte para estructura y verificacion.
- Modelo barato para summaries repetitivos.
- Modelo dedicado para embeddings.

## Documentos actualizados

- `docs/sda-tree-index-live-architecture.md`
- `docs/arquitectura.md`
