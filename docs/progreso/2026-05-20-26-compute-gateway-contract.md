# Compute Gateway contract

Estado: implementado en app, pendiente de levantar en `srv-ia-01`.

## Hecho

- Se agrego cliente server-side `lib/compute-gateway.ts`.
- Inngest ahora:
  - recibe `document/index.requested`;
  - lee metadata del documento;
  - firma una URL temporal de Supabase Storage;
  - crea un job async en `POST /v1/index-jobs` si hay `COMPUTE_GATEWAY_URL`;
  - actualiza `indexing_runs` con `running`, `extracting`, progreso y
    `compute_job_id`;
  - escribe eventos live de dispatch, pending, job creado y error.
- Se agrego gateway minimo Node en `workers/compute-gateway`.
- Se agrego `workers/compute-gateway/deploy.sh` para instalarlo como servicio
  systemd de usuario en `srv-ia-01`.
- El gateway expone:
  - `GET /v1/health`;
  - `POST /v1/index-jobs`;
  - `GET /v1/index-jobs/:id`.
- La UI de timeline muestra `compute_job_id` cuando existe.

## Seguridad

- El gateway recibe una signed URL temporal, no service-role keys.
- No se persiste ni loguea la signed URL.
- El gateway soporta `SDA_COMPUTE_GATEWAY_TOKEN` por `Authorization: Bearer`.

## Pendiente inmediato

- Aprobar Tailscale SSH si lo pide.
- Copiar `workers/compute-gateway` a `srv-ia-01`.
- Levantar servicio systemd de usuario.
- Configurar en Vercel:
  - `COMPUTE_GATEWAY_URL`
  - `COMPUTE_GATEWAY_TOKEN`
- Integrar MinerU donde el gateway hoy deja el job en `downloaded`.
