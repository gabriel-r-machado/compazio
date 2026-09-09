-- The service role is the only application writer. Explicit grants keep local and hosted
-- projects aligned even when the local role seed starts with no table privileges.
grant select, insert, update, delete on public.app_licenses to service_role;
grant select, insert, update, delete on public.license_activations to service_role;
grant select, insert, update, delete on public.license_events to service_role;
grant select, insert, update, delete on public.app_releases to service_role;
