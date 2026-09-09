"use client";

import { useState } from "react";
import type { FormEvent } from "react";

import { getSupabaseBrowserClient } from "../../lib/supabase/browser";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const client = getSupabaseBrowserClient();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (client === null) {
      setStatus("Cloud authentication is not configured for this deployment.");
      return;
    }

    setStatus("Sending a sign-in link…");
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` }
    });
    setStatus(
      error === null ? "Check your inbox for the sign-in link." : "Unable to send sign-in link."
    );
  }

  return (
    <form className="account-card" onSubmit={submit}>
      <label htmlFor="email">Email</label>
      <input
        id="email"
        autoComplete="email"
        onChange={(event) => setEmail(event.target.value)}
        required
        type="email"
        value={email}
      />
      <button disabled={client === null || email.length === 0} type="submit">
        Send sign-in link
      </button>
      {status === null ? null : <p aria-live="polite">{status}</p>}
    </form>
  );
}
