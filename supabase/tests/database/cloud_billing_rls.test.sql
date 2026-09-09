begin;

select plan(18);

set local role postgres;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'member@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'outsider@example.test'),
  ('44444444-4444-4444-8444-444444444444', 'viewer@example.test');

insert into public.organizations (id, name, slug, owner_id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Primary organization', 'primary-org', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Other organization', 'other-org', '33333333-3333-4333-8333-333333333333');

insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'member'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '44444444-4444-4444-8444-444444444444', 'viewer');

select is(
  (select count(*) from public.profiles),
  4::bigint,
  'auth user trigger creates one profile per user'
);

select is(
  (
    select count(*)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = any (array[
        'profiles', 'organizations', 'organization_members', 'devices', 'cloud_projects',
        'cloud_runs', 'cloud_run_events', 'templates', 'template_versions', 'subscriptions',
        'entitlements', 'billing_events', 'audit_logs', 'billing_checkout_sessions'
      ])
      and relation.relrowsecurity
  ),
  14::bigint,
  'every exposed ForgeDeck cloud table has RLS enabled'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select is(
  (select count(*) from public.organizations),
  1::bigint,
  'owner reads only the organization where membership is active'
);

select lives_ok(
  $$
    insert into public.cloud_projects (id, organization_id, local_ref, display_name, sync_enabled)
    values (
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      repeat('a', 64),
      'Public project name',
      true
    )
  $$,
  'owner can create an allowlisted cloud project summary'
);

select is(
  (select count(*) from public.cloud_projects where organization_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0::bigint,
  'owner cannot read another organization cloud projects'
);

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);

select is(
  (select count(*) from public.cloud_projects),
  1::bigint,
  'active member can read organization cloud projects'
);

select lives_ok(
  $$
    insert into public.cloud_runs (
      organization_id, project_id, local_run_ref, status, sanitized_metadata
    ) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      repeat('b', 64),
      'running',
      '{"retryCount": 0}'::jsonb
    )
  $$,
  'active member can append a high-level cloud run'
);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);

select is(
  (select count(*) from public.cloud_projects),
  1::bigint,
  'viewer can read organization summaries'
);

select throws_ok(
  $$
    update public.cloud_projects
    set display_name = 'viewer change'
    where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    returning id
  $$,
  '42501',
  'new row violates row-level security policy for table "cloud_projects"',
  'viewer cannot modify cloud summaries'
);

select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);

select is(
  (select count(*) from public.cloud_projects),
  0::bigint,
  'other organization member cannot read primary organization cloud data'
);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select lives_ok(
  $$
    update public.organization_members
    set revoked_at = now()
    where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and user_id = '22222222-2222-4222-8222-222222222222'
  $$,
  'owner can revoke a member'
);

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);

select is(
  (select count(*) from public.cloud_projects),
  0::bigint,
  'revoked membership immediately loses cloud read access'
);

select throws_ok(
  $$select count(*) from public.billing_events$$,
  '42501',
  'permission denied for table billing_events',
  'billing event ledger is not readable by authenticated clients'
);

select throws_ok(
  $$select count(*) from public.billing_checkout_sessions$$,
  '42501',
  'permission denied for table billing_checkout_sessions',
  'billing checkout correlation is never exposed to authenticated clients'
);

set local role service_role;

select is(
  (
    select public.process_billing_webhook(
      'abacatepay',
      'event-active',
      repeat('c', 64),
      'subscription.completed',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'subscription-primary',
      'customer-primary',
      'pro',
      'active'::public.subscription_status,
      now(),
      now() + interval '30 days',
      null,
      '{"planKey":"pro"}'::jsonb
    ) ->> 'duplicate'
  ),
  'false',
  'first valid webhook updates the entitlement once'
);

select is(
  (
    select public.process_billing_webhook(
      'abacatepay',
      'event-active',
      repeat('c', 64),
      'subscription.completed',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'subscription-primary',
      'customer-primary',
      'pro',
      'active'::public.subscription_status,
      now(),
      now() + interval '30 days',
      null,
      '{"planKey":"pro"}'::jsonb
    ) ->> 'duplicate'
  ),
  'true',
  'duplicate webhook has no duplicate effect'
);

select is(
  (
    select public.process_billing_webhook(
      'abacatepay',
      'event-cancelled',
      repeat('d', 64),
      'subscription.cancelled',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'subscription-primary',
      'customer-primary',
      'pro',
      'cancelled'::public.subscription_status,
      now(),
      now(),
      null,
      '{"planKey":"pro"}'::jsonb
    ) ->> 'cloudSync'
  ),
  'false',
  'cancellation returns cloud capabilities to Community without blocking local functionality'
);

select lives_ok(
  $$select public.reconcile_billing_entitlements()$$,
  'service role can reconcile only the local entitlement projection'
);

select * from finish();
rollback;
