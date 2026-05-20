create or replace function app.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb;
  app_metadata jsonb;
  tenant_profile record;
  event_user_id uuid;
begin
  event_user_id := nullif(event ->> 'user_id', '')::uuid;
  claims := coalesce(event -> 'claims', '{}'::jsonb);
  app_metadata := coalesce(claims -> 'app_metadata', '{}'::jsonb);

  select
    u.tenant_id,
    u.role::text as tenant_role,
    u.status as user_status,
    t.slug as tenant_slug,
    t.status::text as tenant_status
  into tenant_profile
  from public.users u
  join public.tenants t on t.id = u.tenant_id
  where u.id = event_user_id
  limit 1;

  if tenant_profile.tenant_id is null
    or tenant_profile.user_status <> 'active'
    or tenant_profile.tenant_status <> 'active'
  then
    claims := claims
      - 'tenant_id'
      - 'tenant_role'
      - 'tenant_slug'
      - 'tenant_status'
      - 'user_status'
      - 'claims_version';

    app_metadata := app_metadata
      - 'tenant_id'
      - 'tenant_role'
      - 'tenant_slug'
      - 'tenant_status'
      - 'user_status'
      - 'claims_version';

    claims := jsonb_set(claims, '{app_metadata}', app_metadata, true);
    return jsonb_set(event, '{claims}', claims, true);
  end if;

  claims := jsonb_set(claims, '{tenant_id}', to_jsonb(tenant_profile.tenant_id::text), true);
  claims := jsonb_set(claims, '{tenant_role}', to_jsonb(tenant_profile.tenant_role), true);
  claims := jsonb_set(claims, '{tenant_slug}', to_jsonb(tenant_profile.tenant_slug), true);
  claims := jsonb_set(claims, '{tenant_status}', to_jsonb(tenant_profile.tenant_status), true);
  claims := jsonb_set(claims, '{user_status}', to_jsonb(tenant_profile.user_status), true);
  claims := jsonb_set(claims, '{claims_version}', '1'::jsonb, true);

  app_metadata := jsonb_set(app_metadata, '{tenant_id}', to_jsonb(tenant_profile.tenant_id::text), true);
  app_metadata := jsonb_set(app_metadata, '{tenant_role}', to_jsonb(tenant_profile.tenant_role), true);
  app_metadata := jsonb_set(app_metadata, '{tenant_slug}', to_jsonb(tenant_profile.tenant_slug), true);
  app_metadata := jsonb_set(app_metadata, '{tenant_status}', to_jsonb(tenant_profile.tenant_status), true);
  app_metadata := jsonb_set(app_metadata, '{user_status}', to_jsonb(tenant_profile.user_status), true);
  app_metadata := jsonb_set(app_metadata, '{claims_version}', '1'::jsonb, true);

  claims := jsonb_set(claims, '{app_metadata}', app_metadata, true);

  return jsonb_set(event, '{claims}', claims, true);
exception
  when invalid_text_representation then
    return jsonb_build_object(
      'error',
      jsonb_build_object(
        'http_code',
        400,
        'message',
        'Invalid auth event user_id'
      )
    );
end;
$$;

grant usage on schema app to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;

grant execute on function app.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function app.custom_access_token_hook(jsonb) from authenticated, anon, public;

grant select (id, tenant_id, role, status) on public.users to supabase_auth_admin;
grant select (id, slug, status) on public.tenants to supabase_auth_admin;

create policy users_select_auth_admin on public.users
  for select to supabase_auth_admin
  using (true);

create policy tenants_select_auth_admin on public.tenants
  for select to supabase_auth_admin
  using (true);
