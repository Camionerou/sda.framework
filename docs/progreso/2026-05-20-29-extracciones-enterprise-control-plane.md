# Extracciones enterprise: control plane

## Estado

En progreso. Este corte convierte la prueba manual de MinerU en una linea de
ingesta durable, observable y preparada para escala.

## Decision

Para miles de documentos no alcanza con ejecutar MinerU manualmente ni con
guardar outputs solo en disco local.

La arquitectura queda:

- Inngest Cloud orquesta workflows, retries, backoff y concurrencia.
- Supabase Postgres es el control plane canonico.
- Supabase Storage guarda documentos originales y artefactos versionados.
- `srv-ia-01` corre computo pesado, pero no es la fuente de verdad.

## Nuevas entidades

- `document_extractions`: una ejecucion o reutilizacion de extractor por
  documento, parser, version, backend y checksum.
- `document_extraction_artifacts`: archivos producidos por la extraccion,
  versionados y ubicados en Storage.

## Dedupe esperado

La cache de extraccion se dedupea por:

```text
tenant_id + parser + parser_version + parser_backend + extraction_pipeline_version + source_checksum_sha256
```

Si dos documentos del mismo tenant tienen el mismo checksum y ya existe una
extraccion `succeeded`, el segundo documento puede registrar `reused` en vez de
reprocesar MinerU.

Actualizacion 2026-05-21: `extraction_pipeline_version` es parte obligatoria de
la clave de cache. Sin esa columna, una version nueva del pipeline no puede
reextraer la misma fuente.

## Ruta de artefactos

Formato recomendado:

```text
<tenant_id>/<document_id>/extractions/mineru/<mineru_version>/<extraction_id>/...
```

Ejemplos:

- `document.md`
- `content_list.json`
- `content_list_v2.json`
- `middle.json`
- `model.json`
- `layout.pdf`
- `span.pdf`
- `images/...`

## Regla operativa

El upload y la ingesta siguen separados:

- Si la ingesta esta apagada, el documento queda subido.
- Si MinerU falla, el documento no se pierde.
- Si Inngest reintenta, el workflow debe poder detectar artefactos ya
  producidos o una extraccion ya exitosa.
