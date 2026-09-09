import Link from "next/link";

import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="web-shell narrow-shell">
      <nav aria-label="Primary navigation">
        <Link className="wordmark" href="/">
          Compasso
        </Link>
        <span className="local-badge">Optional cloud account</span>
      </nav>
      <section className="hero">
        <p className="fd-eyebrow">Sign in</p>
        <h1>Connect only the cloud features you choose.</h1>
        <p className="lede">
          The local desktop remains useful without an account or network connection.
        </p>
        <LoginForm />
      </section>
    </main>
  );
}
