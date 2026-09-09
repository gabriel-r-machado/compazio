-- PostgREST only exposes configured API schemas. Keep the implementation in private and expose
-- a service-role-only wrapper in public so Edge Functions can call it through supabase-js RPC.
create or replace function public.activate_beta_license(
  p_code_hash text,
  p_installation_hash text,
  p_app_version text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = private, public, extensions, pg_temp
as $$
begin
  return private.activate_beta_license(
    p_code_hash,
    p_installation_hash,
    p_app_version,
    p_correlation_id
  );
end;
$$;

revoke all on function public.activate_beta_license(text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.activate_beta_license(text, text, text, uuid) to service_role;
