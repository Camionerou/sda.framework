# Inngest Cloud setup

Estado: preparado, pendiente de claves y URL publica.

## Hecho

- El cliente Inngest usa `appVersion` si existe `INNGEST_APP_VERSION`,
  `VERCEL_GIT_COMMIT_SHA` o `GITHUB_SHA`.
- `.env.example` incluye `INNGEST_APP_VERSION`.
- La app ya expone `/api/inngest`, que Inngest Cloud debe sincronizar.

## Pendiente manual

- Crear o abrir cuenta de Inngest Cloud.
- Copiar `INNGEST_EVENT_KEY`.
- Copiar `INNGEST_SIGNING_KEY`.
- Configurar esas variables en el hosting cloud de Next.js.
- Deployar la app para obtener URL publica HTTPS.
- Sincronizar en Inngest Cloud la URL:

```text
https://TU-DOMINIO/api/inngest
```

## Importante

En produccion no se debe configurar `INNGEST_DEV=1`. Ese valor es solo para
desarrollo local con Inngest Dev Server.
