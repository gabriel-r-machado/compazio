-- Development seed. Replace UUIDs when using locally.
-- Do not run in production as-is.

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
  id,
  false,
  false,
  false,
  1,
  0,
  'community'
from public.organizations
on conflict (organization_id) do nothing;
