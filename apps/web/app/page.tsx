import { readFeatureFlags } from "@forgedeck/config";

export default function HomePage() {
  const flags = readFeatureFlags(process.env);

  return (
    <main className="web-shell">
      <nav aria-label="Primary navigation">
        <span className="wordmark">
          <span aria-hidden="true">&gt;_&lt;</span> COMPAZIO
        </span>
        <span className="local-badge">Local-first</span>
      </nav>
      <section className="hero">
        <p className="fd-eyebrow">Precisão. Fluxo. Controle.</p>
        <h1>Orquestre agentes e terminais em um só lugar.</h1>
        <p className="lede">
          Um workspace visual, local-first e orientado a evidências para as ferramentas que você já
          usa.
        </p>
        <dl className="flag-grid">
          {Object.entries(flags).map(([name, enabled]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{enabled ? "enabled" : "disabled"}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
