-- Keep the release bucket publicly readable by known object URL, but do not
-- grant anonymous/authenticated listing through storage.objects.
drop policy if exists compazio_releases_public_read on storage.objects;

-- This helper is an administrative migration utility, not an application API.
-- Some existing environments may have it while a fresh database does not.
-- Revoke its public execute surface only when the helper is present so the
-- complete migration chain remains reproducible from an empty database.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end
$$;
