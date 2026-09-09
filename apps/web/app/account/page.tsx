import Link from "next/link";
import { redirect } from "next/navigation";

import { readFeatureFlags } from "@forgedeck/config";

import { AccountActions } from "./account-actions";
import { getSupabaseServerClient } from "../../lib/supabase/server";

export default async function AccountPage() {
  const client = await getSupabaseServerClient();
  if (client === null) {
    return <UnavailableAccount />;
  }

  const {
    data: { user }
  } = await client.auth.getUser();
  if (user === null) {
    redirect("/login");
  }

  const [organizationsResult, entitlementsResult] = await Promise.all([
    client.from("organizations").select("id, name, slug").order("name"),
    client
      .from("entitlements")
      .select(
        "organization_id, cloud_sync, mobile_monitor, private_templates, team_members, cloud_history_days, source"
      )
  ]);
  const organizations = organizationsResult.data ?? [];
  const entitlements = entitlementsResult.data ?? [];
  const flags = readFeatureFlags(process.env);

  return (
    <main className="web-shell narrow-shell">
      <nav aria-label="Primary navigation">
        <Link className="wordmark" href="/">
          Compasso
        </Link>
        <span className="local-badge">Cloud account</span>
      </nav>
      <section className="hero account-page">
        <p className="fd-eyebrow">Account</p>
        <h1>{user.email ?? "Cloud account"}</h1>
        <p className="lede">
          Cloud remains opt-in. Your desktop database and runtime do not depend on this account.
        </p>

        <section className="account-card">
          <h2>Organizations</h2>
          {organizations.length === 0 ? (
            <p>No cloud organization exists yet.</p>
          ) : (
            <ul>
              {organizations.map((organization) => (
                <li key={organization.id}>
                  <strong>{organization.name}</strong>
                  <span>{organization.slug}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="account-card">
          <h2>Capabilities</h2>
          {entitlements.length === 0 ? (
            <p>Community capabilities apply until an entitlement is received.</p>
          ) : (
            <ul>
              {entitlements.map((entitlement) => (
                <li key={entitlement.organization_id}>
                  <strong>{entitlement.source}</strong>
                  <span>
                    Sync: {entitlement.cloud_sync ? "enabled" : "disabled"} · History:{" "}
                    {entitlement.cloud_history_days} days
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="account-link">
          <Link href="/monitor">Open read-only monitor</Link>
        </p>
        <AccountActions
          billingEnabled={flags.billing}
          organizations={organizations.map((organization) => ({
            id: organization.id,
            name: organization.name
          }))}
        />
      </section>
    </main>
  );
}

function UnavailableAccount() {
  return (
    <main className="web-shell narrow-shell">
      <nav aria-label="Primary navigation">
        <Link className="wordmark" href="/">
          Compasso
        </Link>
        <span className="local-badge">Cloud disabled</span>
      </nav>
      <section className="hero account-page">
        <p className="fd-eyebrow">Account unavailable</p>
        <h1>Cloud authentication is not configured.</h1>
        <p className="lede">This does not affect the local Compasso desktop experience.</p>
      </section>
    </main>
  );
}
