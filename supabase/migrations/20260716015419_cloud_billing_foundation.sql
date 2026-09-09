-- ForgeDeck optional cloud foundation. SQLite remains the authority for all local state.
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

create type public.membership_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.subscription_status as enum (
  'inactive', 'trialing', 'active', 'past_due', 'cancelled', 'expired'
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (char_length(display_name) <= 120),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  owner_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.membership_role not null default 'member',
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index organization_members_active_user_idx
  on public.organization_members(user_id, organization_id)
  where revoked_at is null;

create table public.devices (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  display_name text not null check (char_length(display_name) between 1 and 120),
  platform text not null check (platform in ('win32', 'darwin', 'linux')),
  app_version text not null check (char_length(app_version) between 1 and 80),
  public_key text check (public_key is null or char_length(public_key) <= 2048),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index devices_user_active_idx on public.devices(user_id) where revoked_at is null;

create function private.cloud_payload_is_safe(payload jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  item record;
  element jsonb;
begin
  if payload is null then
    return true;
  end if;

  if jsonb_typeof(payload) = 'object' then
    for item in select key, value from jsonb_each(payload) loop
      if item.key ~* '(^|_)(path|code|diff|prompt|terminal|output|env|environment|token|secret|credential|cookie)(_|$)' then
        return false;
      end if;
      if not private.cloud_payload_is_safe(item.value) then
        return false;
      end if;
    end loop;
  elsif jsonb_typeof(payload) = 'array' then
    for element in select value from jsonb_array_elements(payload) loop
      if not private.cloud_payload_is_safe(element) then
        return false;
      end if;
    end loop;
  elsif jsonb_typeof(payload) = 'string' then
    return char_length(payload #>> '{}') <= 2000;
  end if;

  return true;
end;
$$;

create table public.cloud_projects (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  local_ref text not null check (local_ref ~ '^[a-f0-9]{64}$'),
  display_name text not null check (char_length(display_name) between 1 and 120),
  sync_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, local_ref)
);

create table public.cloud_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.cloud_projects(id) on delete cascade,
  local_run_ref text not null check (local_run_ref ~ '^[a-f0-9]{64}$'),
  workflow_id text check (workflow_id is null or char_length(workflow_id) <= 120),
  adapter_id text check (adapter_id is null or char_length(adapter_id) <= 120),
  status text not null check (status in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  summary text check (summary is null or char_length(summary) <= 2000),
  sanitized_metadata jsonb not null default '{}'::jsonb check (private.cloud_payload_is_safe(sanitized_metadata)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, local_run_ref)
);

create index cloud_runs_org_updated_idx on public.cloud_runs(organization_id, updated_at desc);

create table public.cloud_run_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null references public.cloud_runs(id) on delete cascade,
  event_key text not null check (event_key ~ '^[a-f0-9]{64}$'),
  event_type text not null check (event_type in ('run.started', 'node.status_changed', 'run.completed', 'run.summary_updated')),
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb check (private.cloud_payload_is_safe(payload)),
  created_at timestamptz not null default now(),
  unique (run_id, event_key)
);

create index cloud_run_events_run_time_idx on public.cloud_run_events(run_id, occurred_at);

create table public.templates (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  name text not null check (char_length(name) between 1 and 120),
  visibility text not null check (visibility in ('public', 'private', 'organization')),
  latest_version integer not null default 1 check (latest_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, slug)
);

create table public.template_versions (
  template_id uuid not null references public.templates(id) on delete cascade,
  version integer not null check (version > 0),
  manifest jsonb not null check (private.cloud_payload_is_safe(manifest)),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key (template_id, version)
);

create table public.subscriptions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'abacatepay' check (provider = 'abacatepay'),
  provider_subscription_id text unique,
  provider_customer_id text,
  plan_key text not null check (plan_key in ('community', 'pro', 'team')),
  status public.subscription_status not null default 'inactive',
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_until timestamptz,
  cancel_at_period_end boolean not null default false,
  metadata jsonb not null default '{}'::jsonb check (private.cloud_payload_is_safe(metadata)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

create table public.entitlements (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  cloud_sync boolean not null default false,
  mobile_monitor boolean not null default false,
  private_templates boolean not null default false,
  team_members integer not null default 1 check (team_members > 0),
  cloud_history_days integer not null default 0 check (cloud_history_days >= 0),
  source text not null default 'community' check (source in ('community', 'subscription', 'grace')),
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);

create table public.billing_events (
  id uuid primary key default extensions.gen_random_uuid(),
  provider text not null check (provider = 'abacatepay'),
  provider_event_id text,
  event_hash text not null unique check (event_hash ~ '^[a-f0-9]{64}$'),
  event_type text not null check (char_length(event_type) <= 120),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  sanitized_payload jsonb not null default '{}'::jsonb check (private.cloud_payload_is_safe(sanitized_payload)),
  error_code text,
  created_at timestamptz not null default now()
);

create unique index billing_events_provider_event_idx
  on public.billing_events(provider, provider_event_id)
  where provider_event_id is not null;

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null check (char_length(action) <= 120),
  target_type text check (target_type is null or char_length(target_type) <= 120),
  target_id text check (target_id is null or char_length(target_id) <= 160),
  metadata jsonb not null default '{}'::jsonb check (private.cloud_payload_is_safe(metadata)),
  created_at timestamptz not null default now()
);

create index audit_logs_org_created_idx on public.audit_logs(organization_id, created_at desc);

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create function private.add_organization_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.organization_members (organization_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (organization_id, user_id) do update set role = 'owner', revoked_at = null;

  insert into public.entitlements (organization_id)
  values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function private.set_updated_at();
create trigger organizations_set_updated_at before update on public.organizations
for each row execute function private.set_updated_at();
create trigger organization_members_set_updated_at before update on public.organization_members
for each row execute function private.set_updated_at();
create trigger devices_set_updated_at before update on public.devices
for each row execute function private.set_updated_at();
create trigger cloud_projects_set_updated_at before update on public.cloud_projects
for each row execute function private.set_updated_at();
create trigger cloud_runs_set_updated_at before update on public.cloud_runs
for each row execute function private.set_updated_at();
create trigger templates_set_updated_at before update on public.templates
for each row execute function private.set_updated_at();
create trigger subscriptions_set_updated_at before update on public.subscriptions
for each row execute function private.set_updated_at();
create trigger auth_user_created after insert on auth.users
for each row execute function private.handle_new_user();
create trigger organization_created after insert on public.organizations
for each row execute function private.add_organization_owner();

revoke all on function private.cloud_payload_is_safe(jsonb) from public;
revoke all on function private.set_updated_at() from public;
revoke all on function private.handle_new_user() from public;
revoke all on function private.add_organization_owner() from public;
grant usage on schema private to authenticated;
grant execute on function private.cloud_payload_is_safe(jsonb) to authenticated;
