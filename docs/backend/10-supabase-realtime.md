# Supabase Realtime

Contrato vigente para funciones live en SDA Framework.

## Que usar

| Necesidad | Tecnologia | Motivo |
| --- | --- | --- |
| Cambios durables de una fila que la UI ya puede leer por RLS | Postgres Changes | Simple, consistente con Postgres y sirve para bajo/medio volumen. |
| Notificaciones livianas, fanout o eventos custom | Broadcast privado | Payload chico, topic explicito y mejor camino si Postgres Changes empieza a escalar mal. |
| Usuarios conectados o estado efimero lento | Presence privado | Mantiene el estado actual del canal sin persistirlo en tablas de dominio. |
| Chat o agent runtime token-by-token | SSE | El stream de tokens/herramientas no debe depender de cambios de filas ni Presence. |

Fuentes oficiales:

- Supabase Realtime overview: https://supabase.com/docs/guides/realtime
- Postgres Changes: https://supabase.com/docs/guides/realtime/postgres-changes
- Broadcast: https://supabase.com/docs/guides/realtime/broadcast
- Presence: https://supabase.com/docs/guides/realtime/presence
- Authorization: https://supabase.com/docs/guides/realtime/authorization
- Limits: https://supabase.com/docs/guides/realtime/limits

## Superficie actual

Postgres Changes publicados en `supabase_realtime`:

- `documents`
- `indexing_runs`
- `indexing_events`
- `document_extractions`
- `document_extraction_artifacts`
- `workspaces` (Tier 1, migracion `audit_triggers_tier1`)
- `collections` (Tier 1)
- `document_collections` (Tier 1)
- `document_tags` (Tier 1)

Canales privados autorizados por `realtime.messages`:

- `tenant:<tenant_id>:notifications`
- `document:<document_id>:presence`
- `document:<document_id>:indexing`

La autorizacion vive en `app.is_allowed_realtime_topic(topic)`: permite el topic
del tenant actual y documentos visibles por RLS del tenant actual. El filtro
cliente (`document_id=eq...`, `tenant_id=eq...`) reduce ruido, pero la frontera
de seguridad sigue siendo RLS y las policies de `realtime.messages`.

## Implementacion UI

Hooks vigentes:

- `lib/realtime/use-document-indexing-realtime.ts`: `indexing_runs` +
  `indexing_events`, dedupe de eventos, estado de canal y refresh al terminal.
- `lib/realtime/use-document-extractions-realtime.ts`: `document_extractions` +
  `document_extraction_artifacts`.
- `lib/realtime/use-document-presence.ts`: Presence privado por documento.
- `lib/realtime/use-tenant-notifications.ts`: Broadcast privado por tenant.

Pantallas conectadas:

- `/app/documents`: lista live por `documents` filtrado por `tenant_id`.
- `/app/documents/:id`: timeline live compartido.
- `/app/workspace/documents/:id`: indexing, extracciones, artifacts, presence y
  notificaciones de tenant.

Regla para Server Components: render inicial desde Supabase server client; Client
Component se suscribe para cambios incrementales. Si una corrida pasa a estado
terminal, llamar `router.refresh()` para rehidratar `doc_tree`, `chunks`, versiones
y estado documental desde el servidor.

## Broadcast desde DB

Triggers instalados:

- `broadcast_documents_realtime_change`: emite `document_changed` al topic del
  tenant.
- `broadcast_indexing_runs_realtime_change`: emite `run_changed` al topic del
  documento.
- `broadcast_indexing_events_realtime_insert`: emite `event_inserted` al topic
  del documento.

Los payloads son minimos y no incluyen signed URLs, contenido del documento,
service keys ni blobs grandes. Broadcast guarda mensajes en `realtime.messages`
por una ventana corta gestionada por Supabase, asi que no usarlo para secretos.

## Presence

Presence se usa solo para estado lento:

- usuario conectado al documento;
- pagina actual;
- timestamp de ultima actualizacion.

No usar Presence para mousemove, scroll continuo o cursores de alta frecuencia.
Para eso usar Broadcast con throttling o no implementarlo.

## Limites y costo

Realtime cobra por mensajes. Cada cambio de DB recibido por cada cliente cuenta
como mensaje; Broadcast cuenta el envio mas cada receptor. Si una tabla empieza a
generar demasiado volumen, hay tres opciones antes de aumentar cuota:

1. Filtrar mas estrecho por `tenant_id` o `document_id`.
2. Reducir payloads y cantidad de canales.
3. Migrar esa superficie a Broadcast privado con payload custom.

Supabase documenta que Postgres Changes con RLS requiere autorizar cada cambio
por cliente y puede volverse cuello de botella. No usarlo como mecanismo masivo
de eventos de alta frecuencia.

## Checklist para agregar una funcion live

1. Definir si el dato es durable o efimero.
2. Si es durable, crear o reutilizar tabla con RLS y publicarla en
   `supabase_realtime`.
3. Si es efimero, usar Broadcast o Presence privado con topic `scope:id:entity`.
4. Crear test SQL que cubra publication/policy/topic.
5. En React, hacer backfill inicial desde Server Component y dedupe en el hook.
6. Siempre limpiar con `supabase.removeChannel(channel)`.
7. Mostrar estado de canal si la pantalla depende del live update.
8. Para estados terminales que habilitan nuevas queries server-side, refrescar la
   ruta.

## No hacer

- No exponer `service_role` en browser.
- No suscribirse a una tabla completa sin filtro.
- No usar Presence para eventos de alta frecuencia.
- No guardar signed URLs ni contenido pesado en Broadcast.
- No duplicar estado durable en Redis o Broadcast si Postgres ya es la fuente de
  verdad.
