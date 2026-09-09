-- Compazio V2 beta licensing and public release metadata.
-- The desktop never accesses these tables directly; Edge Functions and release scripts use service_role.
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to service_role;

create table if not exists public.app_licenses (
  id uuid primary key default extensions.gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  code_hint text not null check (code_hint ~ '^CMPZ-[A-Z0-9-]{4,40}$'),
  plan text not null check (plan in ('beta_unlimited')),
  status text not null check (status in ('active', 'suspended', 'revoked', 'expired')),
  max_installations integer not null default 1 check (max_installations > 0),
  max_workspaces integer check (max_workspaces is null or max_workspaces > 0),
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.license_activations (
  id uuid primary key default extensions.gen_random_uuid(),
  license_id uuid not null references public.app_licenses(id) on delete cascade,
  installation_hash text not null check (installation_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('active', 'deactivated', 'expired')),
  activated_at timestamptz not null default now(),
  last_refreshed_at timestamptz not null default now(),
  deactivated_at timestamptz,
  app_version text check (app_version is null or char_length(app_version) <= 80),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists license_activations_active_install_idx
  on public.license_activations(license_id, installation_hash)
  where status = 'active';
create index if not exists license_activations_license_status_idx
  on public.license_activations(license_id, status);

create table if not exists public.license_events (
  id uuid primary key default extensions.gen_random_uuid(),
  license_id uuid references public.app_licenses(id) on delete set null,
  activation_id uuid references public.license_activations(id) on delete set null,
  event_type text not null check (char_length(event_type) <= 80),
  outcome text not null check (char_length(outcome) <= 40),
  installation_hash text check (installation_hash is null or installation_hash ~ '^[a-f0-9]{64}$'),
  app_version text check (app_version is null or char_length(app_version) <= 80),
  correlation_id uuid not null,
  safe_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists license_events_license_created_idx
  on public.license_events(license_id, created_at desc);

create table if not exists public.app_releases (
  id uuid primary key default extensions.gen_random_uuid(),
  channel text not null check (channel in ('beta', 'stable')),
  version text not null check (char_length(version) between 1 and 80),
  platform text not null check (platform in ('windows')),
  architecture text not null check (architecture in ('x64', 'arm64', 'ia32')),
  installer_path text not null check (char_length(installer_path) <= 512),
  update_metadata_path text check (update_metadata_path is null or char_length(update_metadata_path) <= 512),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes > 0),
  signed boolean not null default false,
  status text not null check (status in ('draft', 'validating', 'published', 'withdrawn')),
  release_notes_path text check (release_notes_path is null or char_length(release_notes_path) <= 512),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (channel, version, platform, architecture)
);
create index if not exists app_releases_current_idx
  on public.app_releases(channel, platform, architecture, status, published_at desc);

create or replace function private.set_compazio_license_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_licenses_set_updated_at on public.app_licenses;
create trigger app_licenses_set_updated_at before update on public.app_licenses
for each row execute function private.set_compazio_license_updated_at();
drop trigger if exists license_activations_set_updated_at on public.license_activations;
create trigger license_activations_set_updated_at before update on public.license_activations
for each row execute function private.set_compazio_license_updated_at();

-- This function is the race-free activation gate. It runs only for service_role callers from Edge
-- Functions and returns no information when the code hash is unknown.
create or replace function private.activate_beta_license(
  p_code_hash text,
  p_installation_hash text,
  p_app_version text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  license_row public.app_licenses%rowtype;
  activation_row public.license_activations%rowtype;
  active_count integer;
begin
  select * into license_row from public.app_licenses where code_hash = p_code_hash for update;
  if not found then return null; end if;
  if license_row.status <> 'active' then return jsonb_build_object('error', 'inactive'); end if;
  if license_row.expires_at is not null and license_row.expires_at <= now() then
    update public.app_licenses set status = 'expired' where id = license_row.id;
    return jsonb_build_object('error', 'expired');
  end if;

  select * into activation_row from public.license_activations
    where license_id = license_row.id and installation_hash = p_installation_hash and status = 'active'
    for update;
  if found then
    update public.license_activations
      set last_refreshed_at = now(), app_version = p_app_version
      where id = activation_row.id
      returning * into activation_row;
  else
    select count(*) into active_count from public.license_activations
      where license_id = license_row.id and status = 'active';
    if active_count >= license_row.max_installations then
      return jsonb_build_object('error', 'limit');
    end if;
    insert into public.license_activations (license_id, installation_hash, status, app_version)
      values (license_row.id, p_installation_hash, 'active', p_app_version)
      returning * into activation_row;
  end if;
  insert into public.license_events (license_id, activation_id, event_type, outcome, installation_hash, app_version, correlation_id)
    values (license_row.id, activation_row.id, 'license.activate', 'accepted', p_installation_hash, p_app_version, p_correlation_id);
  return jsonb_build_object(
    'licenseId', license_row.id,
    'activationId', activation_row.id,
    'plan', license_row.plan,
    'maxWorkspaces', license_row.max_workspaces,
    'expiresAt', license_row.expires_at,
    'licenseVersion', license_row.version
  );
end;
$$;
revoke all on function private.set_compazio_license_updated_at() from public, anon, authenticated;
revoke all on function private.activate_beta_license(text, text, text, uuid) from public, anon, authenticated;
grant execute on function private.activate_beta_license(text, text, text, uuid) to service_role;

alter table public.app_licenses enable row level security;
alter table public.license_activations enable row level security;
alter table public.license_events enable row level security;
alter table public.app_releases enable row level security;
revoke all on public.app_licenses from anon, authenticated;
revoke all on public.license_activations from anon, authenticated;
revoke all on public.license_events from anon, authenticated;
revoke all on public.app_releases from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'compazio-releases',
  'compazio-releases',
  true,
  314572800,
  array['application/vnd.microsoft.portable-executable', 'application/octet-stream', 'application/x-msdownload', 'application/x-bzip2', 'text/yaml', 'application/x-yaml', 'application/json', 'text/plain']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists compazio_releases_public_read on storage.objects;
create policy compazio_releases_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'compazio-releases');
drop policy if exists compazio_releases_private_write on storage.objects;
create policy compazio_releases_private_write on storage.objects
  for all to anon, authenticated
  using (false) with check (false);
