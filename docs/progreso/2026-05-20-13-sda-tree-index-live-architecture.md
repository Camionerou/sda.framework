# SDA Tree Index + Live Architecture

Estado: documentado como decision de arquitectura.

## Hecho

Se bajo a documento la decision de construir un indexador propio:

```text
docs/sda-tree-index-live-architecture.md
```

## Decision

- Evitar naive RAG.
- Usar MinerU como primera herramienta de extraccion fiel.
- Usar LangGraph para construir, verificar y refinar un arbol semantico.
- Usar Inngest como orquestador durable.
- Usar `srv-ia-01` como compute gateway para computo caro.
- Tratar PageIndex como referencia conceptual, no como dependencia central.
- Priorizar streaming y live features en upload, indexacion y chat.

## Nota

La UI debe sentirse en vivo siempre que sea posible: progreso de upload,
timeline de indexacion, preview parcial del arbol, streaming de tool calls y
respuesta del agente token por token.
