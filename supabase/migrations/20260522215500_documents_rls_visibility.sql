-- 036 — RLS policy revisada para public.documents (Tier 1).
-- Reemplaza documents_select_tenant (que solo filtraba tenant_id) por una
-- policy basada en app.user_can_read_document(id), que ya combina:
--   * tenant admin -> ve todo dentro del tenant
--   * miembro del workspace home del documento (directo o via grupo)
--   * documento incluido en una collection con visibility='tenant_public'
--
-- Tambien filtramos deleted_at is null para que documentos soft-deleted
-- desaparezcan completamente del SELECT incluso para admins (el rescate va
-- por RPC public.restore_document).
--
-- Mutaciones (INSERT/UPDATE/DELETE) ya van por RPCs security definer desde
-- 20260521120000_documents_rpc_write_boundary.sql. Mantenemos esa ausencia
-- de policies de update aqui (DROP IF EXISTS por idempotencia).

drop policy if exists documents_select_tenant on public.documents;

create policy documents_select_visible on public.documents
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
    and (select app.user_can_read_document(id))
  );

-- Idempotente: documents_update_tenant fue droppeada en 20260521120000.
drop policy if exists documents_update_tenant on public.documents;
-- No se crea reemplazo: toda mutacion va por RPC security definer.

-- documents_delete_owner_uploading_failed se preserva tal cual: el owner
-- puede borrar fisicamente registros propios en estado uploading/failed
-- para limpiar uploads abortados. El soft-delete general va por RPC.
