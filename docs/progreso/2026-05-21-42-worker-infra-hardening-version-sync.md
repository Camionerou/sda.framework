# 2026-05-21 - Worker infra hardening y version sync

Estado: implementado y verificado localmente. `versions:sync` tambien se corrio
contra Supabase remoto.

## Cambios aplicados

- Compute Gateway y Tree Indexer fallan cerrado si no hay bearer token. El modo
  sin auth queda solo como opt-in local con `SDA_ALLOW_UNAUTHENTICATED_WORKER=1`.
- `GET /v1/health` del Compute Gateway ahora requiere auth y no expone URL
  interna del Tree Indexer.
- Ambos workers limitan bodies HTTP con
  `SDA_COMPUTE_GATEWAY_MAX_BODY_BYTES` / `SDA_TREE_INDEXER_MAX_BODY_BYTES`.
- `lib/compute-gateway.ts` parsea respuestas HTTP de forma defensiva y reporta
  errores no JSON con status y body truncado.
- Los deploy scripts aplican `chmod 600` a `.env` remotos.
- Se agrego CI para lint, typecheck, build, version check, dry-run de
  `versions:sync`, tests Python y tests SQL de Supabase.
- `indexing:health --strict` queda para anomalias operativas; el drift de
  versiones es informativo por defecto.
- `--require-fresh-indexes` permite convertir drift de versiones en fallo
  explicito cuando se quiera exigir reindexacion total.

## Versionado

`lib/system-versions.ts` es la fuente de verdad del repo. La tabla
`system_component_versions` es un espejo runtime que consume la RPC
`request_document_indexing`.

Los bumps de version no requieren migration propia. Despues de un deploy o bump
operativo:

```bash
npm run versions:sync
```

Para CI o revision local sin tocar DB:

```bash
npm run versions:sync -- --dry-run
```

## Reindexacion

No se reindexa automaticamente por cada bump. Un documento con version anterior
sigue siendo usable mientras tenga `doc_tree` y `chunks` validos. El drift sirve
para auditoria y para decidir reindexaciones selectivas cuando una nueva version
cambia calidad, parsing, estructura o compatibilidad.

## Verificacion

Comandos corridos:

```bash
npm ci
npm run lint
npm run typecheck
npm run build
python3 -m pytest
npm run test:db
npm run versions:check -- --base HEAD
npm run versions:sync -- --dry-run
npm run versions:sync
npm run indexing:health
```

Checks manuales:

- Compute Gateway sin token devuelve `503` en `/v1/health`.
- Compute Gateway con token devuelve health sanitizado.
- Compute Gateway devuelve `413` cuando el body supera el limite configurado.
- Tree Indexer sin token devuelve `401`.
- Tree Indexer con token devuelve health sanitizado.
- Tree Indexer devuelve `413` cuando el body supera el limite configurado.

Estado remoto despues de `versions:sync`:

- app `0.1.3`
- compute gateway extraction `0.1.2`
- extraction pipeline `0.1.3`
- indexing pipeline `0.1.3`
- tree indexer Python `0.1.2`
