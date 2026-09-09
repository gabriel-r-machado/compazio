import Link from "next/link";
import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "../../lib/supabase/server";

export default async function MonitorPage() {
  const client = await getSupabaseServerClient();
  if (client === null) {
    return <UnavailableMonitor />;
  }

  const {
    data: { user }
  } = await client.auth.getUser();
  if (user === null) {
    redirect("/login");
  }

  const { data: runs } = await client
    .from("cloud_runs")
    .select("id, status, workflow_id, adapter_id, duration_ms, summary, updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);

  return (
    <main className="web-shell narrow-shell">
      <nav aria-label="Primary navigation">
        <Link className="wordmark" href="/">
          Compasso
        </Link>
        <span className="local-badge">Read-only monitor</span>
      </nav>
      <section className="hero account-page">
        <p className="fd-eyebrow">Monitor</p>
        <h1>Run summaries only.</h1>
        <p className="lede">
          No terminal output, source code, diffs, paths or remote controls are available here.
        </p>
        <section className="account-card">
          <h2>Recent runs</h2>
          {runs === null || runs.length === 0 ? (
            <p>No synchronized run summaries yet.</p>
          ) : (
            <ul>
              {runs.map((run) => (
                <li key={run.id}>
                  <strong>{run.status}</strong>
                  <span>
                    {run.workflow_id ?? "Workflow"} · {run.adapter_id ?? "adapter unavailable"} ·{" "}
                    {run.duration_ms ?? 0} ms
                  </span>
                  {run.summary === null ? null : <span>{run.summary}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </section>
    </main>
  );
}

function UnavailableMonitor() {
  return (
    <main className="web-shell narrow-shell">
      <nav aria-label="Primary navigation">
        <Link className="wordmark" href="/">
          Compasso
        </Link>
        <span className="local-badge">Cloud disabled</span>
      </nav>
      <section className="hero account-page">
        <p className="fd-eyebrow">Monitor unavailable</p>
        <h1>Enable and configure cloud before using the monitor.</h1>
      </section>
    </main>
  );
}
