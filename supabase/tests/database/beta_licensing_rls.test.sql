begin;
select plan(14);

select is(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'app_licenses'),
  true,
  'app_licenses has RLS enabled'
);
select is(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'license_activations'),
  true,
  'license_activations has RLS enabled'
);
select is(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'license_events'),
  true,
  'license_events has RLS enabled'
);
select is(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'app_releases'),
  true,
  'app_releases has RLS enabled'
);

set local role anon;
select throws_ok($$select * from public.app_licenses$$, '42501', 'permission denied for table app_licenses', 'anon cannot read licenses');
select throws_ok($$select * from public.license_activations$$, '42501', 'permission denied for table license_activations', 'anon cannot read activations');
select throws_ok($$insert into public.app_licenses(code_hash,code_hint,plan,status) values(repeat('a',64),'CMPZ-AAAA','beta_unlimited','active')$$, '42501', 'permission denied for table app_licenses', 'anon cannot issue licenses');
select throws_ok($$select * from public.app_releases$$, '42501', 'permission denied for table app_releases', 'anon cannot read release metadata directly');
select throws_ok($$insert into public.license_activations(license_id,installation_hash,status) values(gen_random_uuid(),repeat('b',64),'active')$$, '42501', 'permission denied for table license_activations', 'anon cannot insert activations');
select throws_ok($$insert into public.license_events(event_type,outcome,correlation_id) values('test','denied',gen_random_uuid())$$, '42501', 'permission denied for table license_events', 'anon cannot insert events');
select throws_ok($$insert into public.app_releases(channel,version,platform,architecture,installer_path,sha256,size_bytes,status) values('beta','test','windows','x64','x.exe',repeat('c',64),1,'draft')$$, '42501', 'permission denied for table app_releases', 'anon cannot publish releases');
select throws_ok($$insert into storage.objects(bucket_id,name,owner) values('compazio-releases','public-test.exe',null)$$, '42501', 'new row violates row-level security policy for table "objects"', 'anon cannot upload releases');

set local role service_role;
select is((select private.activate_beta_license(repeat('f',64), repeat('e',64), 'test', gen_random_uuid())), null::jsonb, 'unknown code does not reveal license existence');
insert into public.app_licenses(code_hash,code_hint,plan,status) values(repeat('d',64),'CMPZ-TEST','beta_unlimited','active');
select is(
  (private.activate_beta_license(repeat('d',64), repeat('e',64), 'test', gen_random_uuid())->>'activationId'),
  (private.activate_beta_license(repeat('d',64), repeat('e',64), 'test', gen_random_uuid())->>'activationId'),
  'activation is idempotent for the same installation'
);
select * from finish();
rollback;
