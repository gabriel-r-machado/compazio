"use client";

import { useState } from "react";

interface AccountOrganization {
  readonly id: string;
  readonly name: string;
}

interface AccountActionsProps {
  readonly billingEnabled: boolean;
  readonly organizations: readonly AccountOrganization[];
}

export function AccountActions({ billingEnabled, organizations }: AccountActionsProps) {
  const [deletionStatus, setDeletionStatus] = useState<string | null>(null);
  const [billingStatus, setBillingStatus] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? "");

  async function deleteAccount(): Promise<void> {
    if (!window.confirm("Delete your cloud account and any personal cloud organizations?")) {
      return;
    }

    setDeletionStatus("Deleting cloud account…");
    const response = await fetch("/api/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE" })
    });
    const payload: unknown = await response.json().catch(() => null);
    setDeletionStatus(
      response.ok
        ? "Cloud account deleted. Local desktop data was not changed."
        : payload !== null
          ? "Unable to delete cloud account. Transfer any shared organization ownership first."
          : "Unable to delete cloud account."
    );
  }

  async function startCheckout(plan: "pro" | "team"): Promise<void> {
    if (organizationId.length === 0) {
      setBillingStatus("Create or join an organization before selecting a plan.");
      return;
    }
    setBillingStatus("Opening secure checkoutâ€¦");
    const response = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId, plan })
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok && isCheckoutResponse(payload)) {
      window.location.assign(payload.checkoutUrl);
      return;
    }
    setBillingStatus("Checkout is unavailable. Your local Compasso remains fully usable.");
  }

  async function cancelSubscription(): Promise<void> {
    if (
      organizationId.length === 0 ||
      !window.confirm("Cancel this cloud subscription immediately?")
    ) {
      return;
    }
    setBillingStatus("Requesting cancellationâ€¦");
    const response = await fetch("/api/billing/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId })
    });
    setBillingStatus(
      response.ok
        ? "Cancellation is pending verified provider confirmation."
        : "Cancellation could not be requested. Your local Compasso remains fully usable."
    );
  }

  return (
    <section className="account-card danger-zone">
      <h2>Data controls</h2>
      <p>
        Export contains cloud account data only; local projects, code and terminal output are
        excluded.
      </p>
      <div className="action-row">
        <a className="button-link" href="/api/account/export">
          Export cloud data
        </a>
        <button type="button" onClick={() => void deleteAccount()}>
          Delete cloud account
        </button>
      </div>
      {deletionStatus === null ? null : <p aria-live="polite">{deletionStatus}</p>}
      {!billingEnabled ? null : (
        <section className="account-card">
          <h2>Subscription</h2>
          <p>
            Checkout is server-side. Redirects do not activate a plan; only verified webhooks do.
          </p>
          <label>
            Organization
            <select
              value={organizationId}
              onChange={(event) => setOrganizationId(event.target.value)}
            >
              <option value="">Select an organization</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>
          <div className="action-row">
            <button type="button" onClick={() => void startCheckout("pro")}>
              Upgrade to Pro
            </button>
            <button type="button" onClick={() => void startCheckout("team")}>
              Upgrade to Team
            </button>
            <button type="button" onClick={() => void cancelSubscription()}>
              Cancel subscription
            </button>
          </div>
          {billingStatus === null ? null : <p aria-live="polite">{billingStatus}</p>}
        </section>
      )}
    </section>
  );
}

function isCheckoutResponse(value: unknown): value is Readonly<{ checkoutUrl: string }> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "checkoutUrl" in value &&
    typeof value.checkoutUrl === "string"
  );
}
