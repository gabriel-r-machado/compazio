interface OnboardingPanelProps {
  readonly onOpenRepositories: () => void;
  readonly onExploreCanvas: () => void;
}

export function OnboardingPanel(props: OnboardingPanelProps) {
  return (
    <section className="onboarding-panel" aria-labelledby="onboarding-title" role="dialog">
      <div>
        <p className="fd-eyebrow">First local run</p>
        <h2 id="onboarding-title">Start with evidence, not a remote account.</h2>
        <p>
          Compazio keeps your canvas, repositories and run evidence on this machine. Cloud sync,
          billing, remote control and telemetry stay off unless you explicitly opt in later.
        </p>
      </div>
      <ol>
        <li>
          <strong>Choose a local Git repository</strong>
          <span>Compazio validates the directory before it creates an isolated worktree.</span>
        </li>
        <li>
          <strong>Plan on the canvas</strong>
          <span>Nodes describe work; the run and its evidence remain the source of truth.</span>
        </li>
        <li>
          <strong>Review gates before delivery</strong>
          <span>Exit codes, diffs and reports are recorded locally for human review.</span>
        </li>
      </ol>
      <div className="onboarding-actions">
        <button className="primary-button" type="button" onClick={props.onOpenRepositories}>
          Add a local repository
        </button>
        <button type="button" onClick={props.onExploreCanvas}>
          Explore the canvas
        </button>
      </div>
    </section>
  );
}
