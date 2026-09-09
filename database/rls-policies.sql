alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.devices enable row level security;
alter table public.cloud_projects enable row level security;
alter table public.cloud_runs enable row level security;
alter table public.cloud_run_events enable row level security;
alter table public.templates enable row level security;
alter table public.template_versions enable row level security;
alter table public.subscriptions enable row level security;
alter table public.entitlements enable row level security;
alter table public.billing_events enable row level security;
alter table public.audit_logs enable row level security;

create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_org_admin(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  );
$$;

create policy "profile self read"
on public.profiles for select
using (id = auth.uid());

create policy "profile self update"
on public.profiles for update
using (id = auth.uid())
with check (id = auth.uid());

create policy "members can read organizations"
on public.organizations for select
using (public.is_org_member(id));

create policy "members can read memberships"
on public.organization_members for select
using (public.is_org_member(organization_id));

create policy "admins manage memberships"
on public.organization_members for all
using (public.is_org_admin(organization_id))
with check (public.is_org_admin(organization_id));

create policy "users manage own devices"
on public.devices for all
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "members read cloud projects"
on public.cloud_projects for select
using (public.is_org_member(organization_id));

create policy "members write cloud projects"
on public.cloud_projects for all
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

create policy "members read cloud runs"
on public.cloud_runs for select
using (public.is_org_member(organization_id));

create policy "members write cloud runs"
on public.cloud_runs for all
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

create policy "members read cloud run events"
on public.cloud_run_events for select
using (public.is_org_member(organization_id));

create policy "members write cloud run events"
on public.cloud_run_events for insert
with check (public.is_org_member(organization_id));

create policy "public or authorized templates"
on public.templates for select
using (
  visibility = 'public'
  or owner_id = auth.uid()
  or (organization_id is not null and public.is_org_member(organization_id))
);

create policy "owners manage templates"
on public.templates for all
using (
  owner_id = auth.uid()
  or (organization_id is not null and public.is_org_admin(organization_id))
)
with check (
  owner_id = auth.uid()
  or (organization_id is not null and public.is_org_admin(organization_id))
);

create policy "visible template versions"
on public.template_versions for select
using (
  exists (
    select 1 from public.templates t
    where t.id = template_id
      and (
        t.visibility = 'public'
        or t.owner_id = auth.uid()
        or (t.organization_id is not null and public.is_org_member(t.organization_id))
      )
  )
);

create policy "members read subscriptions"
on public.subscriptions for select
using (public.is_org_member(organization_id));

create policy "members read entitlements"
on public.entitlements for select
using (public.is_org_member(organization_id));

create policy "members read audit logs"
on public.audit_logs for select
using (public.is_org_member(organization_id));

-- billing_events intentionally has no client policy.
-- Writes and reads happen through trusted server-side code only.
