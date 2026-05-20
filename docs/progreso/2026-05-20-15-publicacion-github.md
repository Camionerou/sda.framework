# Publicacion inicial en GitHub

Estado: listo para push inicial.

## Hecho

- Se preparo el primer commit del proyecto.
- Se verifico que `.env.local`, `.claude`, `.firecrawl`, `.next` y
  `node_modules` queden fuera de Git.
- Se removio el vendoreo activo de PageIndex antes del primer push porque el
  camino principal paso a ser `SDA Tree Indexer`.
- Se corrio validacion local antes de publicar.

## Checks

```text
npm run lint
npm run typecheck
npm run build
```

Los tres checks pasan.
