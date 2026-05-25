-- Wave 0: sistema de configurabilidad universal
-- Spec ref: §5.5 Configurabilidad universal

create table app_settings (
  id            uuid primary key default gen_random_uuid(),
  key           text not null,
  scope_type    text not null default 'global'
                check (scope_type in ('global','doc_type','collection','document')),
  scope_value   text,
  value         jsonb not null,
  value_type    text not null
                check (value_type in (
                  'string','number','boolean','object','array',
                  'duration_ms','prompt_template','model_id','json_schema','enum'
                )),
  description   text,
  default_value jsonb not null,
  validation_schema jsonb,
  is_secret     boolean not null default false,
  is_locked     boolean not null default false,
  deprecated_at timestamptz,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  unique (key, scope_type, scope_value)
);
create index on app_settings (key) where deprecated_at is null;
create index on app_settings (scope_type, scope_value);

create table app_settings_history (
  id          uuid primary key default gen_random_uuid(),
  setting_id  uuid not null references app_settings(id) on delete cascade,
  prev_value  jsonb,
  new_value   jsonb not null,
  changed_at  timestamptz not null default now(),
  changed_by  text not null,
  reason      text
);
create index on app_settings_history (setting_id);

create function on_setting_changed() returns trigger language plpgsql as $$
begin
  insert into app_settings_history (setting_id, prev_value, new_value, changed_by, reason)
    values (new.id, old.value, new.value, coalesce(new.updated_by, 'system'), 'auto');
  perform pg_notify('settings_changed', json_build_object(
    'key', new.key, 'scope_type', new.scope_type, 'scope_value', new.scope_value
  )::text);
  return new;
end $$;
create trigger trg_setting_changed after update on app_settings
  for each row execute function on_setting_changed();
