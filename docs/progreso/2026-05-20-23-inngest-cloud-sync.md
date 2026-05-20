# Inngest Cloud sync

Estado: sincronizado.

## Hecho

- Se sincronizo la app `sda-framework` en Inngest Cloud.
- Endpoint sincronizado:

```text
https://sda-framework.vercel.app/api/inngest
```

- Inngest Cloud respondio `success`.
- Sync id:

```text
78a7485f-aeaf-4c5a-b388-32722b29d94e
```

## Verificacion

- `/api/inngest` en Vercel responde `401 Unauthorized` sin firma, esperado.
- Sync programatico contra Inngest Cloud respondio `200`.

## Nota

La signing key autentica el sync de la app. La event key no sirve para esta
operacion; se usa para enviar eventos.
