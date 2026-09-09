create function public.delete_cloud_account(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.organizations as organization
    join public.organization_members as membership
      on membership.organization_id = organization.id
    where organization.owner_id = p_user_id
      and membership.revoked_at is null
      and membership.user_id <> p_user_id
  ) then
    raise exception 'Transfer ownership of shared organizations before deleting this account';
  end if;

  delete from public.organizations where owner_id = p_user_id;
  delete from auth.sessions where user_id = p_user_id;
  delete from auth.users where id = p_user_id;
  return true;
end;
$$;

revoke all on function public.delete_cloud_account(uuid) from public;
grant execute on function public.delete_cloud_account(uuid) to service_role;
