-- Server-side checkout correlation. This table is never exposed to browser or desktop clients.
create table public.billing_checkout_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  initiated_by uuid not null references public.profiles(id) on delete cascade,
  external_id text not null unique check (external_id ~ '^fd_checkout_[a-z0-9-]{36}$'),
  provider_checkout_id text unique,
  plan_key text not null check (plan_key in ('pro', 'team')),
  state text not null default 'pending' check (state in ('pending', 'created', 'completed', 'failed', 'expired', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index billing_checkout_sessions_org_created_idx
  on public.billing_checkout_sessions(organization_id, created_at desc);

create trigger billing_checkout_sessions_set_updated_at before update on public.billing_checkout_sessions
for each row execute function private.set_updated_at();

alter table public.billing_checkout_sessions enable row level security;
revoke all on public.billing_checkout_sessions from anon, authenticated;

-- Periodically repair the entitlement projection from the local subscription ledger.
-- The server-side reconciler is deliberately unable to manufacture a subscription:
-- only a verified webhook inserts or changes subscription state.
create function public.reconcile_billing_entitlements()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  reconciled_count integer;
begin
  with resolved as (
    select
      subscription.organization_id,
      entitlement.cloud_sync,
      entitlement.mobile_monitor,
      entitlement.private_templates,
      entitlement.team_members,
      entitlement.cloud_history_days,
      entitlement.source
    from public.subscriptions as subscription
    cross join lateral private.resolve_entitlements(
      subscription.plan_key,
      subscription.status,
      subscription.grace_until
    ) as entitlement
  )
  insert into public.entitlements (
    organization_id,
    cloud_sync,
    mobile_monitor,
    private_templates,
    team_members,
    cloud_history_days,
    source
  )
  select
    organization_id,
    cloud_sync,
    mobile_monitor,
    private_templates,
    team_members,
    cloud_history_days,
    source
  from resolved
  on conflict (organization_id) do update set
    cloud_sync = excluded.cloud_sync,
    mobile_monitor = excluded.mobile_monitor,
    private_templates = excluded.private_templates,
    team_members = excluded.team_members,
    cloud_history_days = excluded.cloud_history_days,
    source = excluded.source,
    version = public.entitlements.version + 1,
    updated_at = now()
  where (
    public.entitlements.cloud_sync,
    public.entitlements.mobile_monitor,
    public.entitlements.private_templates,
    public.entitlements.team_members,
    public.entitlements.cloud_history_days,
    public.entitlements.source
  ) is distinct from (
    excluded.cloud_sync,
    excluded.mobile_monitor,
    excluded.private_templates,
    excluded.team_members,
    excluded.cloud_history_days,
    excluded.source
  );

  get diagnostics reconciled_count = row_count;
  return reconciled_count;
end;
$$;

revoke all on function public.reconcile_billing_entitlements() from public;
grant execute on function public.reconcile_billing_entitlements() to service_role;
