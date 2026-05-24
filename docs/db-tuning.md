# DB index tuning workflow

Workflow para evaluar índices nuevos antes de crearlos en producción, usando `hypopg` + `index_advisor` en staging.

## Cuándo usar este workflow

- Una query nueva es lenta en staging con dataset realista.
- `pg_stat_statements` muestra una query con `mean_exec_time` alto en producción.
- Antes de agregar un índice a una migración productiva, validar que el planner efectivamente lo va a usar.

## Setup (una vez por entorno staging)

```sql
create extension if not exists hypopg with schema extensions;
```

Si la extensión no está disponible en el plan Supabase del proyecto staging, escalar a plan Pro/Team o usar EXPLAIN manual sin hypopg (menos preciso).

## Workflow paso a paso

### 1. Identificar query lenta

```sql
select substr(query, 1, 80) as query_head,
       calls,
       round(mean_exec_time::numeric, 2) as mean_ms,
       rows
from pg_stat_statements
order by mean_exec_time desc
limit 20;
```

### 2. Tomar el EXPLAIN base

```sql
explain (analyze, buffers, format text)
select ... ;
```

Guardar el output. Anotar `cost`, `rows`, scan type (Seq Scan vs Index Scan), y `Buffers: shared hit/read`.

### 3. Hipotetizar el índice con hypopg

```sql
select * from hypopg_create_index('create index on public.chunks using gin (tenant_id, content_tsv)');
```

Retorna un `indexrelid` hipotético — no escribe a disco.

### 4. Re-correr el EXPLAIN

```sql
explain (format text) select ...;
```

Comparar: ¿el planner ahora lo usa? ¿el cost bajó significativamente? Un índice que el planner ignora es índice muerto — no agregarlo.

### 5. Resetear hipótesis

```sql
select hypopg_reset();
```

### 6. Si vale la pena, crearlo de verdad en migración

Usar `CREATE INDEX CONCURRENTLY` para no bloquear writes en producción:

```sql
create index concurrently if not exists chunks_content_tsv_tenant_gin_idx
  on public.chunks
  using gin (tenant_id, content_tsv);
```

> **Gotcha**: `CONCURRENTLY` no funciona dentro de una transacción. Si la migración tiene otros statements, separar en migraciones distintas o usar el patrón de bloque `commit` explícito (raro en Supabase managed).

## Index advisor (one-shot)

Supabase Cloud expone `index_advisor` que combina hypopg con sugerencias automáticas:

```sql
select * from index_advisor('select ... from chunks where ...');
```

Retorna sugerencias con costos antes/después. Útil para queries opacas (LangGraph retrieval, search hybrid).

## Reglas

- **Nunca** crear índices nuevos directamente en producción sin pasar por este workflow en staging primero.
- Cada índice tiene costo: WAL, bloat, planning overhead. No es free.
- Si el dataset de staging es < 10% del de producción, los costos del planner se distorsionan. En ese caso reproducir con `ANALYZE` forzado o levantar staging con dataset escalado.
- Cuando agregues un índice, anotar en `docs/db-extensions.md` qué query lo justifica.
- Si después de N semanas en producción un índice tiene `idx_scan = 0` en `pg_stat_user_indexes`, removerlo.

## Verificar uso de índices en producción

```sql
select
  schemaname,
  relname as table,
  indexrelname as index,
  idx_scan,
  pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes
where schemaname = 'public'
order by idx_scan asc, pg_relation_size(indexrelid) desc
limit 30;
```

Índices con `idx_scan = 0` y tamaño > 1 MB son candidatos a remover.
