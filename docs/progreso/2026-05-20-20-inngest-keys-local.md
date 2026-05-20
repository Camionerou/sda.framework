# Inngest keys local

Estado: configurado localmente.

## Hecho

- `INNGEST_EVENT_KEY` quedo cargada en `.env.local`.
- `INNGEST_SIGNING_KEY` quedo cargada en `.env.local`.
- `INNGEST_DEV` no queda configurado localmente, para que el endpoint use modo
  cloud con signing key.
- `.env.local` esta ignorado por Git.
- `/api/inngest` responde `401 Unauthorized` ante un request sin firma, que es
  el comportamiento esperado cuando el signing key esta activo.

## Pendiente

- Deployar Next.js en una URL publica HTTPS.
- Configurar las mismas variables en el hosting cloud.
- Sincronizar `https://TU-DOMINIO/api/inngest` desde Inngest Cloud.
- Rotar las claves despues de validar, porque fueron compartidas en chat.
