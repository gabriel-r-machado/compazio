-- RLS and privileged server procedures for optional cloud data.
grant usage on schema private to authenticated;

create function private.is_active_org_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = (select auth.uid())
      and membership.revoked_at is null
  );
$$;

create function private.is_active_org_admin(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = (select auth.uid())
      and membership.revoked_at is null
      and membership.role in ('owner', 'admin')
  );
$$;

create function private.is_active_org_owner(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = (select auth.uid())
      and membership.revoked_at is null
      and membership.role = 'owner'
  );
$$;

create function private.is_active_org_contributor(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = (select auth.uid())
      and membership.revoked_at is null
      and membership.role in ('owner', 'admin', 'member')
  );
$$;

create function private.prevent_owner_loss()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (
      select 1 from public.organizations as organization
      where organization.id = old.organization_id
    ) then
      return old;
    end if;

    if old.role = 'owner' and old.revoked_at is null and not exists (
      select 1
      from public.organization_members as membership
      where membership.organization_id = old.organization_id
        and membership.role = 'owner'
        and membership.revoked_at is null
        and membership.user_id <> old.user_id
    ) then
      raise exception 'An organization must retain an active owner';
    end if;
    return old;
  end if;

  if old.role = 'owner' and old.revoked_at is null and (new.role <> 'owner' or new.revoked_at is not null) and not exists (
    select 1
    from public.organization_members as membership
    where membership.organization_id = old.organization_id
      and membership.role = 'owner'
      and membership.revoked_at is null
      and membership.user_id <> old.user_id
  ) then
    raise exception 'An organization must retain an active owner';
  end if;
  return new;
end;
$$;

create function private.prevent_organization_owner_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.owner_id <> new.owner_id then
    raise exception 'Transfer organization ownership through a dedicated server-side operation';
  end if;
  return new;
end;
$$;

create trigger organization_members_prevent_owner_loss
before update or delete on public.organization_members
for each row execute function private.prevent_owner_loss();
create trigger organizations_prevent_owner_change
before update on public.organizations
for each row execute function private.prevent_organization_owner_change();

revoke all on function private.is_active_org_member(uuid) from public;
revoke all on function private.is_active_org_admin(uuid) from public;
revoke all on function private.is_active_org_owner(uuid) from public;
revoke all on function private.is_active_org_contributor(uuid) from public;
revoke all on function private.prevent_owner_loss() from public;
revoke all on function private.prevent_organization_owner_change() from public;
grant execute on function private.is_active_org_member(uuid) to authenticated;
grant execute on function private.is_active_org_admin(uuid) to authenticated;
grant execute on function private.is_active_org_owner(uuid) to authenticated;
grant execute on function private.is_active_org_contributor(uuid) to authenticated;

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

revoke all on all tables in schema public from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.organization_members to authenticated;
grant select, insert, update, delete on public.devices to authenticated;
grant select, insert, update, delete on public.cloud_projects to authenticated;
grant select, insert, update, delete on public.cloud_runs to authenticated;
grant select, insert on public.cloud_run_events to authenticated;
grant select on public.templates, public.template_versions to anon;
grant select, insert, update, delete on public.templates, public.template_versions to authenticated;
grant select on public.subscriptions, public.entitlements, public.audit_logs to authenticated;

create policy "profile owner reads self"
on public.profiles for select to authenticated
using ((select auth.uid()) = id);

create policy "profile owner updates self"
on public.profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "active members read organization"
on public.organizations for select to authenticated
using (private.is_active_org_member(id));

create policy "authenticated users create owned organization"
on public.organizations for insert to authenticated
with check ((select auth.uid()) = owner_id);

create policy "active organization admins update organization"
on public.organizations for update to authenticated
using (private.is_active_org_admin(id))
with check (private.is_active_org_admin(id));

create policy "active organization owners delete organization"
on public.organizations for delete to authenticated
using (private.is_active_org_owner(id));

create policy "active members read organization memberships"
on public.organization_members for select to authenticated
using (private.is_active_org_member(organization_id));

create policy "active organization admins add memberships"
on public.organization_members for insert to authenticated
with check (private.is_active_org_admin(organization_id));

create policy "active organization admins update memberships"
on public.organization_members for update to authenticated
using (private.is_active_org_admin(organization_id))
with check (private.is_active_org_admin(organization_id));

create policy "active organization admins remove memberships"
on public.organization_members for delete to authenticated
using (private.is_active_org_admin(organization_id));

create policy "device owner reads device"
on public.devices for select to authenticated
using ((select auth.uid()) = user_id);

create policy "device owner creates device"
on public.devices for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and (organization_id is null or private.is_active_org_member(organization_id))
);

create policy "device owner updates device"
on public.devices for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and (organization_id is null or private.is_active_org_member(organization_id))
);

create policy "device owner deletes device"
on public.devices for delete to authenticated
using ((select auth.uid()) = user_id);

create policy "active members read cloud projects"
on public.cloud_projects for select to authenticated
using (private.is_active_org_member(organization_id));

create policy "active members create cloud projects"
on public.cloud_projects for insert to authenticated
with check (private.is_active_org_contributor(organization_id));

create policy "active members update cloud projects"
on public.cloud_projects for update to authenticated
using (private.is_active_org_member(organization_id))
with check (private.is_active_org_contributor(organization_id));

create policy "active members delete cloud projects"
on public.cloud_projects for delete to authenticated
using (private.is_active_org_contributor(organization_id));

create policy "active members read cloud runs"
on public.cloud_runs for select to authenticated
using (private.is_active_org_member(organization_id));

create policy "active members create cloud runs"
on public.cloud_runs for insert to authenticated
with check (private.is_active_org_contributor(organization_id));

create policy "active members update cloud runs"
on public.cloud_runs for update to authenticated
using (private.is_active_org_member(organization_id))
with check (private.is_active_org_contributor(organization_id));

create policy "active members delete cloud runs"
on public.cloud_runs for delete to authenticated
using (private.is_active_org_contributor(organization_id));

create policy "active members read cloud run events"
on public.cloud_run_events for select to authenticated
using (private.is_active_org_member(organization_id));

create policy "active members append cloud run events"
on public.cloud_run_events for insert to authenticated
with check (private.is_active_org_contributor(organization_id));

create policy "public templates are readable anonymously"
on public.templates for select to anon
using (visibility = 'public');

create policy "visible templates are readable by authenticated users"
on public.templates for select to authenticated
using (visibility = 'public' or owner_id = (select auth.uid()) or (organization_id is not null and private.is_active_org_member(organization_id)));

create policy "template owners create templates"
on public.templates for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and (organization_id is null or private.is_active_org_contributor(organization_id))
);

create policy "template owners or admins update templates"
on public.templates for update to authenticated
using (owner_id = (select auth.uid()) or (organization_id is not null and private.is_active_org_contributor(organization_id)))
with check (owner_id = (select auth.uid()) or (organization_id is not null and private.is_active_org_contributor(organization_id)));

create policy "template owners or admins delete templates"
on public.templates for delete to authenticated
using (owner_id = (select auth.uid()) or (organization_id is not null and private.is_active_org_contributor(organization_id)));

create policy "public template versions are readable anonymously"
on public.template_versions for select to anon
using (
  exists (
    select 1
    from public.templates as template
    where template.id = template_id
      and template.visibility = 'public'
  )
);

create policy "visible template versions are readable by authenticated users"
on public.template_versions for select to authenticated
using (
  exists (
    select 1
    from public.templates as template
    where template.id = template_id
      and (template.visibility = 'public' or template.owner_id = (select auth.uid()) or (template.organization_id is not null and private.is_active_org_member(template.organization_id)))
  )
);

create policy "template owners or admins manage versions"
on public.template_versions for all to authenticated
using (
  exists (
    select 1
    from public.templates as template
    where template.id = template_id
      and (template.owner_id = (select auth.uid()) or (template.organization_id is not null and private.is_active_org_contributor(template.organization_id)))
  )
)
with check (
  exists (
    select 1
    from public.templates as template
    where template.id = template_id
      and (template.owner_id = (select auth.uid()) or (template.organization_id is not null and private.is_active_org_contributor(template.organization_id)))
  )
);

create policy "active members read subscriptions"
on public.subscriptions for select to authenticated
using (private.is_active_org_member(organization_id));

create policy "active members read entitlements"
on public.entitlements for select to authenticated
using (private.is_active_org_member(organization_id));

create policy "active members read audit logs"
on public.audit_logs for select to authenticated
using (private.is_active_org_member(organization_id));

create function private.resolve_entitlements(
  p_plan_key text,
  p_status public.subscription_status,
  p_grace_until timestamptz
)
returns table (
  cloud_sync boolean,
  mobile_monitor boolean,
  private_templates boolean,
  team_members integer,
  cloud_history_days integer,
  source text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  is_entitled boolean := p_status in ('active', 'trialing') or (p_status = 'past_due' and p_grace_until > now());
begin
  if not is_entitled then
    return query select false, false, false, 1, 0, 'community'::text;
    return;
  end if;

  if p_plan_key = 'team' then
    return query select true, true, true, 10, 365, case when p_status = 'past_due' then 'grace' else 'subscription' end;
    return;
  end if;

  if p_plan_key = 'pro' then
    return query select true, true, true, 1, 90, case when p_status = 'past_due' then 'grace' else 'subscription' end;
    return;
  end if;

  return query select false, false, false, 1, 0, 'community'::text;
end;
$$;

create function public.process_billing_webhook(
  p_provider text,
  p_provider_event_id text,
  p_event_hash text,
  p_event_type text,
  p_organization_id uuid,
  p_provider_subscription_id text,
  p_provider_customer_id text,
  p_plan_key text,
  p_status public.subscription_status,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz,
  p_grace_until timestamptz,
  p_sanitized_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  billing_event_id uuid;
  resolved record;
begin
  insert into public.billing_events (
    provider,
    provider_event_id,
    event_hash,
    event_type,
    sanitized_payload
  ) values (
    p_provider,
    p_provider_event_id,
    p_event_hash,
    p_event_type,
    p_sanitized_payload
  ) on conflict do nothing returning id into billing_event_id;

  if billing_event_id is null then
    return jsonb_build_object('duplicate', true);
  end if;

  insert into public.subscriptions (
    organization_id,
    provider,
    provider_subscription_id,
    provider_customer_id,
    plan_key,
    status,
    current_period_start,
    current_period_end,
    grace_until,
    metadata
  ) values (
    p_organization_id,
    p_provider,
    p_provider_subscription_id,
    p_provider_customer_id,
    p_plan_key,
    p_status,
    p_current_period_start,
    p_current_period_end,
    p_grace_until,
    p_sanitized_payload
  ) on conflict (organization_id, provider) do update set
    provider_subscription_id = excluded.provider_subscription_id,
    provider_customer_id = excluded.provider_customer_id,
    plan_key = excluded.plan_key,
    status = excluded.status,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    grace_until = excluded.grace_until,
    metadata = excluded.metadata;

  select * into resolved from private.resolve_entitlements(p_plan_key, p_status, p_grace_until);

  insert into public.entitlements (
    organization_id,
    cloud_sync,
    mobile_monitor,
    private_templates,
    team_members,
    cloud_history_days,
    source
  ) values (
    p_organization_id,
    resolved.cloud_sync,
    resolved.mobile_monitor,
    resolved.private_templates,
    resolved.team_members,
    resolved.cloud_history_days,
    resolved.source
  ) on conflict (organization_id) do update set
    cloud_sync = excluded.cloud_sync,
    mobile_monitor = excluded.mobile_monitor,
    private_templates = excluded.private_templates,
    team_members = excluded.team_members,
    cloud_history_days = excluded.cloud_history_days,
    source = excluded.source,
    version = public.entitlements.version + 1,
    updated_at = now();

  update public.billing_events
  set processed_at = now(), status = 'processed'
  where id = billing_event_id;

  insert into public.audit_logs (organization_id, action, target_type, target_id, metadata)
  values (
    p_organization_id,
    'billing.webhook_processed',
    'subscription',
    coalesce(p_provider_subscription_id, p_provider_event_id),
    jsonb_build_object('eventType', p_event_type, 'eventHash', p_event_hash)
  );

  return jsonb_build_object(
    'duplicate', false,
    'cloudSync', resolved.cloud_sync,
    'mobileMonitor', resolved.mobile_monitor,
    'privateTemplates', resolved.private_templates,
    'teamMembers', resolved.team_members,
    'cloudHistoryDays', resolved.cloud_history_days,
    'source', resolved.source
  );
exception when others then
  update public.billing_events
  set status = 'failed', error_code = sqlstate
  where id = billing_event_id;
  raise;
end;
$$;

revoke all on function private.resolve_entitlements(text, public.subscription_status, timestamptz) from public;
revoke all on function public.process_billing_webhook(text, text, text, text, uuid, text, text, text, public.subscription_status, timestamptz, timestamptz, timestamptz, jsonb) from public;
grant execute on function public.process_billing_webhook(text, text, text, text, uuid, text, text, text, public.subscription_status, timestamptz, timestamptz, timestamptz, jsonb) to service_role;
