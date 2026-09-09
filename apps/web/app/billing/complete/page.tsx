import Link from "next/link";

export default function BillingCompletePage() {
  return (
    <main className="web-shell narrow-shell">
      <nav aria-label="Primary navigation">
        <Link className="wordmark" href="/">
          Compasso
        </Link>
        <span className="local-badge">Billing pending</span>
      </nav>
      <section className="hero account-page">
        <p className="fd-eyebrow">Payment received</p>
        <h1>Waiting for verified subscription confirmation.</h1>
        <p className="lede">
          Returning from checkout never changes your plan. Compasso enables a subscription only
          after its signed provider webhook is processed.
        </p>
        <p className="account-link">
          <Link href="/account">Return to account</Link>
        </p>
      </section>
    </main>
  );
}
