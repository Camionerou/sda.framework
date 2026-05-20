# Documentos: Detalle

Estado: listo, pendiente de prueba visual manual en sesión autenticada.

## Hecho

- Se empezó una vista de detalle por documento:

```text
/app/documents/[id]
```

- Se agregó ruta de descarga con URL firmada:

```text
/app/documents/[id]/download
```

- Se agregó `lib/documents.ts` para compartir:
  - tipos de documento
  - formato de bytes
  - labels/tone de status
- La tabla de `/app/documents` empezó a linkear cada documento al detalle.

## Verificado

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- La URL firmada del PDF real devuelve:
  - HTTP `200`
  - `content-type: application/pdf`
  - `content-length: 68022`
- Las rutas de detalle y descarga redirigen a `/login` si no hay sesión.

## Pendiente visual

- Probar descarga firmada desde una sesión autenticada.
- Ajustar UI si hay detalles visuales.

## Archivos relevantes

- `app/app/documents/[id]/page.tsx`
- `app/app/documents/[id]/download/route.ts`
- `app/app/documents/page.tsx`
- `lib/documents.ts`
