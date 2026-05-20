# PageIndex Tree Builder Reference

Estado: documentado.

## Que se agrego

Se creo `docs/pageindex-tree-builder-reference.md` como referencia estable para
no volver a investigar como PageIndex arma el arbol.

Puntos fijados:

- El arbol candidato lo genera un LLM.
- MinerU aporta evidencia, paginas, layout y contenido durable.
- Las heuristicas deterministicas solo preparan, validan, normalizan y
  persisten.
- Si no hay provider/modelo LLM, no se persiste arbol fake.
- El flujo replica PageIndex: paginas etiquetadas, lista jerarquica
  `{ structure, title, physical_index }`, verificacion LLM, reparacion,
  conversion a `start_index/end_index`, refinamiento recursivo y summaries.

## Documentos tocados

- `docs/pageindex-tree-builder-reference.md`
- `docs/arquitectura.md`
- `docs/sda-tree-index-live-architecture.md`
- `docs/progreso/README.md`

