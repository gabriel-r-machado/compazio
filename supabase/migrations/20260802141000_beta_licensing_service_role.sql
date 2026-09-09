-- service_role is the only runtime caller of private licensing functions.
grant usage on schema private to service_role;
grant execute on function private.activate_beta_license(text, text, text, uuid) to service_role;
grant select, insert, update, delete on public.app_licenses to service_role;
grant select, insert, update, delete on public.license_activations to service_role;
grant select, insert, update, delete on public.license_events to service_role;
grant select, insert, update, delete on public.app_releases to service_role;
