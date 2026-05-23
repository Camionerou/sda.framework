-- 031.a — agregar documents.workspace_id NULLABLE + FK composite.
-- El backfill ocurre en 031.b. set not null en 031.c.

alter table public.documents
  add column workspace_id uuid,
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users(id) on delete set null;

alter table public.documents
  add constraint documents_workspace_fk
  foreign key (tenant_id, workspace_id)
  references public.workspaces(tenant_id, id) on delete restrict
  not valid;
-- `not valid`: no escanea filas existentes (todas tienen workspace_id NULL,
-- aceptables ahora). Se validara despues del backfill en 031.c.

-- Indice intermedio para apoyar el join del backfill. Final en 031.c.
create index if not exists documents_tenant_workspace_partial_idx
  on public.documents (tenant_id, workspace_id)
  where workspace_id is not null;

-- Indice para localizar documentos sin workspace (used by 031.b backfill query)
create index if not exists documents_workspace_id_null_idx
  on public.documents (tenant_id)
  where workspace_id is null and deleted_at is null;
