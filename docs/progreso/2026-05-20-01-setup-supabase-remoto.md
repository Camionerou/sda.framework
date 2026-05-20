# Setup Supabase Remoto

Estado: listo.

## Hecho

- Supabase CLI actualizado a `2.100.1`.
- Proyecto local inicializado con `supabase/`.
- Proyecto remoto vinculado:
  - nombre: `sda.framework`
  - ref: `anfawvxfepowsudlffnl`
  - URL: `https://anfawvxfepowsudlffnl.supabase.co`
- Baseline remoto traído al repo como migración inicial.
- `supabase/config.toml` quedó configurado para el proyecto local/remoto.

## Archivos relevantes

- `supabase/config.toml`
- `supabase/migrations/20260520145128_initial_remote_schema.sql`
- `.env.example`

## Notas

- `.env.local` existe localmente y está gitignored.
- No se deben commitear secrets de Google, Supabase service role ni tokens.
