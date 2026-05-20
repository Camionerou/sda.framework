# Compute Gateway: MinerU automatizado

## Estado

Completado como primer corte real de extraccion automatizada.

## Que cambio

- `sda-compute-gateway` ya no queda en `downloaded`.
- Descarga el documento desde una signed URL privada.
- Ejecuta MinerU real con backend `pipeline`.
- Sube artefactos versionados a Supabase Storage.
- Expone el manifest del job en `GET /v1/index-jobs/:id`.
- Limita concurrencia con `SDA_COMPUTE_GATEWAY_CONCURRENCY`.

## Artefactos persistidos

Ruta:

```text
<tenant_id>/<document_id>/extractions/mineru/<mineru_version>/<job_id>/...
```

Incluye:

- markdown
- `content_list.json`
- `content_list_v2.json`
- `middle.json`
- `model.json`
- PDFs de debug visual
- imagenes extraidas
- log de MinerU

## Smoke real

Documento:

```text
SALDIVIA BUSES PORTFOLIO_compressed.pdf
document_id: 2e1c2b6b-e608-461a-aab7-1f4c4c34f408
job_id: 564cf426-09ad-4e2a-95fd-da1c077dba65
```

Resultado:

- estado gateway: `succeeded`
- artefactos subidos: `49`
- bytes en Storage: `5.807.898`
- paginas detectadas: `12`
- items `content_list`: `84`
- tipos: `40` imagenes, `25` textos, `19` headers

## Pendiente inmediato

Inngest Cloud ya cierra el loop de extraccion:

1. crear job en el gateway;
2. poller `GET /v1/index-jobs/:id`;
3. persistir `document_extractions`;
4. persistir `document_extraction_artifacts`;
5. avanzar el documento a `structuring`, donde entra LangGraph Tree Indexer.

Smoke cloud:

```text
event_id: 01KS3HQZM38MEG8C3TFM3G06ZJ
run_id: 2047c294-c4c8-4698-8ba9-d77af6e49e86
compute_job_id: 63d9abe4-93d1-4471-bcfa-4466f0eba9ce
```

Resultado:

- `indexing_runs.status`: `running`
- `indexing_runs.stage`: `structuring`
- `indexing_runs.progress`: `35`
- `documents.status`: `structuring`
- `documents.status_reason`: `Extraccion MinerU lista; Tree Indexer pendiente`
- `document_extractions.status`: `succeeded`
- `document_extraction_artifacts`: `49` filas

Siguiente corte real: implementar LangGraph Tree Indexer sobre los artefactos
MinerU ya persistidos.
