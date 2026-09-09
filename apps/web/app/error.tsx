"use client";

import { useEffect } from "react";

export default function WebError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    document.documentElement.dataset.renderStatus = "failed";
  }, [error]);

  return (
    <main className="web-shell">
      <section className="fd-error-boundary" aria-live="assertive" role="alert">
        <p className="fd-eyebrow">Application error</p>
        <h1>The web surface could not render.</h1>
        <p>{error.message}</p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
