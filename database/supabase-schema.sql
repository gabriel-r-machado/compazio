-- ForgeDeck optional cloud schema
create extension if not exists pgcrypto;

create type public.membership_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.subscription_status as enum (
  'inactive', 'trialing', 'active', 'past_due', 'cancelled', 'expired'
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  owner_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.membership_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  display_name text not null,
  platform text not null check (platform in ('win32', 'darwin', 'linux')),
  app_version text not null,
  public_key text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.cloud_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  local_ref text not null,
  display_name text not null,
  sync_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, local_ref)
);

create table public.cloud_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.cloud_projects(id) on delete cascade,
  local_run_ref text not null,
  workflow_id text,
  status text not null,
  started_at timestamptz,
  completed_at timestamptz,
  summary text,
  sanitized_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, local_run_ref)
);

create table public.cloud_run_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null references public.cloud_runs(id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index cloud_run_events_run_time_idx
  on public.cloud_run_events(run_id, occurred_at);

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  slug text not null,
  name text not null,
  visibility text not null check (visibility in ('public', 'private', 'organization')),
  latest_version integer not null default 1,
  created_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, slug)
);

create table public.template_versions (
  template_id uuid not null references public.templates(id) on delete cascade,
  version integer not null,
  manifest jsonb not null,
  checksum text not null,
  created_at timestamptz not null default now(),
  primary key (template_id, version)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'abacatepay',
  provider_subscription_id text unique,
  provider_customer_id text,
  plan_key text not null,
  status public.subscription_status not null default 'inactive',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.entitlements (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  cloud_sync boolean not null default false,
  mobile_monitor boolean not null default false,
  private_templates boolean not null default false,
  team_members integer not null default 1,
  cloud_history_days integer not null default 0,
  source text not null default 'community',
  updated_at timestamptz not null default now()
);

create table public.billing_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text,
  event_hash text not null unique,
  event_type text not null,
  processed_at timestamptz,
  status text not null default 'received',
  sanitized_payload jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
