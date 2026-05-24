begin;
select plan(4);

-- Verificar que cambios a collection.visibility y workspace_memberships
-- registran audit_log entries automaticos.

insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111', 'audit-t1', 'Audit T1');
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a@t.test');
insert into public.users (id, tenant_id, email, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a@t.test', 'admin', 'active');
insert into public.workspaces (id, tenant_id, slug, name) values
  ('99990000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'ws', 'WS');
insert into public.collections (id, tenant_id, workspace_id, slug, name, visibility) values
  ('cccc0000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '99990000-0000-0000-0000-000000000001', 'col', 'Col', 'workspace_private');

-- contar audits previos
select is(
  (select count(*) from public.audit_log
   where resource_id = 'cccc0000-0000-0000-0000-000000000001'
     and action = 'collection.visibility_changed'),
  0::bigint, 'sin audits previos para esta collection');

-- cambio sin tocar visibility: NO debe disparar
update public.collections set name = 'Col2' where id = 'cccc0000-0000-0000-0000-000000000001';
select is(
  (select count(*) from public.audit_log
   where resource_id = 'cccc0000-0000-0000-0000-000000000001'
     and action = 'collection.visibility_changed'),
  0::bigint, 'cambio de nombre no dispara audit de visibility');

-- cambio de visibility: SI debe disparar
update public.collections set visibility = 'tenant_public'
where id = 'cccc0000-0000-0000-0000-000000000001';
select is(
  (select count(*) from public.audit_log
   where resource_id = 'cccc0000-0000-0000-0000-000000000001'
     and action = 'collection.visibility_changed'),
  1::bigint, 'cambio de visibility dispara audit');

-- membership change dispara audit
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role)
values ('99990000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'user', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'workspace_admin');
select is(
  (select count(*) from public.audit_log
   where resource_id = '99990000-0000-0000-0000-000000000001'
     and action = 'workspace.membership_inserted'),
  1::bigint, 'membership insert dispara audit');

select * from finish();
rollback;
