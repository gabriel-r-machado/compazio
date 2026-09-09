import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  GitProjectDto,
  ManagedWorktreeDto,
  MergePlanDto,
  PrReadyReportDto,
  QualityGateDefinitionDto,
  QualityGateRunDto,
  WorktreeDiffDto,
  WorktreeStatusDto
} from "@forgedeck/schemas";
import { useI18n } from "./i18n";

interface MergePreview {
  readonly plan: MergePlanDto;
  readonly confirmationToken: string | null;
}

interface GitReviewPanelProps {
  readonly initialProjectId: string | null;
}

export function GitReviewPanel(props: GitReviewPanelProps) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<GitProjectDto[]>([]);
  const [projectId, setProjectId] = useState(() => props.initialProjectId ?? "");
  const [worktrees, setWorktrees] = useState<ManagedWorktreeDto[]>([]);
  const [worktreeId, setWorktreeId] = useState("");
  const [status, setStatus] = useState<WorktreeStatusDto | null>(null);
  const [diff, setDiff] = useState<WorktreeDiffDto | null>(null);
  const [gates, setGates] = useState<QualityGateDefinitionDto[]>([]);
  const [runs, setRuns] = useState<QualityGateRunDto[]>([]);
  const [report, setReport] = useState<PrReadyReportDto | null>(null);
  const [merge, setMerge] = useState<MergePreview | null>(null);
  const [taskKey, setTaskKey] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const selectedWorktree = worktrees.find((worktree) => worktree.id === worktreeId) ?? null;

  const perform = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await action();
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : t("git.operationFailed"));
      } finally {
        setBusy(false);
        setPendingAction(null);
      }
    },
    [t]
  );

  const loadProjects = useCallback(async () => {
    const next = await window.forgedeck.projects.list();
    setProjects(next);
    setProjectId((current) =>
      next.some((project) => project.id === current) ? current : (next[0]?.id ?? "")
    );
  }, []);

  const loadWorktrees = useCallback(async (nextProjectId: string) => {
    const next = await window.forgedeck.worktrees.list({ projectId: nextProjectId });
    setWorktrees(next);
    setWorktreeId((current) =>
      next.some((worktree) => worktree.id === current) ? current : (next[0]?.id ?? "")
    );
  }, []);

  const loadReview = useCallback(async (nextWorktreeId: string) => {
    const [nextStatus, nextDiff, nextGates, nextRuns] = await Promise.all([
      window.forgedeck.worktrees.status({ worktreeId: nextWorktreeId }),
      window.forgedeck.worktrees.diff({ worktreeId: nextWorktreeId }),
      window.forgedeck.qualityGates.discover({ worktreeId: nextWorktreeId }),
      window.forgedeck.qualityGates.listRuns({ worktreeId: nextWorktreeId })
    ]);
    setStatus(nextStatus);
    setDiff(nextDiff);
    setGates(nextGates);
    setRuns(nextRuns);
  }, []);

  useEffect(() => {
    let active = true;
    void window.forgedeck.projects
      .list()
      .then((next) => {
        if (!active) return;
        setProjects(next);
        setProjectId((current) =>
          next.some((project) => project.id === current) ? current : (next[0]?.id ?? "")
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : t("git.listProjectsFailed"));
      });
    return () => {
      active = false;
    };
  }, [t]);

  useEffect(() => {
    if (projectId === "") return;
    let active = true;
    void window.forgedeck.worktrees
      .list({ projectId })
      .then((next) => {
        if (!active) return;
        setWorktrees(next);
        setWorktreeId((current) =>
          next.some((worktree) => worktree.id === current) ? current : (next[0]?.id ?? "")
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : t("git.listWorktreesFailed"));
      });
    return () => {
      active = false;
    };
  }, [projectId, t]);

  useEffect(() => {
    if (worktreeId === "") return;
    let active = true;
    void Promise.all([
      window.forgedeck.worktrees.status({ worktreeId }),
      window.forgedeck.worktrees.diff({ worktreeId }),
      window.forgedeck.qualityGates.discover({ worktreeId }),
      window.forgedeck.qualityGates.listRuns({ worktreeId })
    ])
      .then(([nextStatus, nextDiff, nextGates, nextRuns]) => {
        if (!active) return;
        setStatus(nextStatus);
        setDiff(nextDiff);
        setGates(nextGates);
        setRuns(nextRuns);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : t("git.loadFailed"));
      });
    return () => {
      active = false;
    };
  }, [t, worktreeId]);

  const latestRuns = useMemo(() => {
    const latest = new Map<QualityGateRunDto["presetId"], QualityGateRunDto>();
    for (const run of runs) {
      if (!latest.has(run.presetId)) latest.set(run.presetId, run);
    }
    return latest;
  }, [runs]);

  return (
    <section className="git-review" aria-label={t("git.aria")}>
      <header className="git-review-header">
        <div>
          <p className="fd-eyebrow">{t("git.eyebrow")}</p>
          <h2>{t("git.title")}</h2>
        </div>
        <button
          className="primary-button"
          disabled={busy}
          type="button"
          onClick={() =>
            void perform(async () => {
              const result = await window.forgedeck.projects.choose();
              if (result.project !== null) {
                await loadProjects();
                setProjectId(result.project.id);
                setMessage(t("git.projectAdded", { name: result.project.name }));
              }
            })
          }
        >
          {t("git.addRepository")}
        </button>
      </header>

      {error === null ? null : <p className="review-notice is-error">{error}</p>}
      {message === null ? null : <p className="review-notice">{message}</p>}

      <div className="review-grid">
        <aside className="review-sidebar">
          <label>
            {t("git.project")}
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">{t("git.selectRepository")}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} · {project.defaultBranch}
                </option>
              ))}
            </select>
          </label>

          {selectedProject === null ? null : (
            <form
              className="worktree-form"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  const created = await window.forgedeck.worktrees.create({
                    projectId: selectedProject.id,
                    taskKey,
                    taskTitle
                  });
                  setTaskKey("");
                  setTaskTitle("");
                  await loadWorktrees(selectedProject.id);
                  setWorktreeId(created.id);
                  setMessage(t("git.created", { branch: created.branchName }));
                });
              }}
            >
              <strong>{t("git.newWorktree")}</strong>
              <input
                aria-label={t("git.taskKey")}
                maxLength={80}
                pattern="[A-Za-z0-9_-]+"
                placeholder={t("git.taskKeyPlaceholder")}
                required
                value={taskKey}
                onChange={(event) => setTaskKey(event.target.value)}
              />
              <input
                aria-label={t("git.taskTitle")}
                maxLength={200}
                placeholder={t("git.taskTitlePlaceholder")}
                required
                value={taskTitle}
                onChange={(event) => setTaskTitle(event.target.value)}
              />
              <button disabled={busy} type="submit">
                {t("git.createWorktree")}
              </button>
            </form>
          )}

          <nav className="worktree-list" aria-label={t("git.managedWorktrees")}>
            {worktrees.map((worktree) => (
              <button
                className={worktree.id === worktreeId ? "is-active" : ""}
                key={worktree.id}
                type="button"
                onClick={() => setWorktreeId(worktree.id)}
              >
                <strong>{worktree.taskKey}</strong>
                <span>{worktree.taskTitle}</span>
                <code>{worktree.branchName}</code>
              </button>
            ))}
          </nav>
        </aside>

        <div className="review-content">
          {selectedWorktree === null || status === null || diff === null ? (
            <div className="empty-review">{t("git.empty")}</div>
          ) : (
            <>
              <section className="review-card status-card">
                <div>
                  <p className="fd-eyebrow">{t("git.currentEvidence")}</p>
                  <h3>{selectedWorktree.branchName}</h3>
                </div>
                <div className="status-pills">
                  <span className={status.dirty ? "is-warning" : "is-pass"}>
                    {t(status.dirty ? "git.dirty" : "git.clean")}
                  </span>
                  <span className={status.leased || status.gitLocked ? "is-warning" : "is-pass"}>
                    {t(status.leased || status.gitLocked ? "git.locked" : "git.available")}
                  </span>
                  <code>{status.headCommit.slice(0, 12)}</code>
                </div>
              </section>

              <section className="review-card">
                <div className="card-heading">
                  <div>
                    <p className="fd-eyebrow">{t("git.commandResults")}</p>
                    <h3>{t("git.qualityGates")}</h3>
                  </div>
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => void perform(() => loadReview(worktreeId))}
                  >
                    {t("common.refresh")}
                  </button>
                </div>
                <div className="gate-grid">
                  {gates.map((gate) => {
                    const run = latestRuns.get(gate.id);
                    const action = `gate:${gate.id}`;
                    return (
                      <article key={gate.id}>
                        <strong>{gate.label}</strong>
                        <span>{run === undefined ? t("git.notRun") : run.state}</span>
                        <small>
                          {run?.exitCode === undefined || run.exitCode === null
                            ? t("git.noExit")
                            : `exit ${run.exitCode} · ${run.durationMs ?? 0}ms`}
                        </small>
                        {pendingAction === action ? (
                          <div className="confirm-row">
                            <button
                              className="danger-button"
                              disabled={busy}
                              type="button"
                              onClick={() =>
                                void perform(async () => {
                                  await window.forgedeck.qualityGates.run({
                                    worktreeId,
                                    presetId: gate.id,
                                    confirmed: true
                                  });
                                  await loadReview(worktreeId);
                                  setMessage(t("git.gateFinished", { gate: gate.label }));
                                })
                              }
                            >
                              {t("git.confirmRun")}
                            </button>
                            <button type="button" onClick={() => setPendingAction(null)}>
                              {t("common.cancel")}
                            </button>
                          </div>
                        ) : (
                          <button
                            disabled={busy}
                            type="button"
                            onClick={() => setPendingAction(action)}
                          >
                            {t("git.runGate", { gate: gate.label })}
                          </button>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="review-card">
                <div className="card-heading">
                  <div>
                    <p className="fd-eyebrow">{t("git.comparison")}</p>
                    <h3>{t("git.diffViewer")}</h3>
                  </div>
                  <span>
                    {t("git.files", { count: diff.files.length + diff.untrackedFiles.length })}
                  </span>
                </div>
                <div className="changed-files">
                  {diff.files.map((file) => (
                    <code key={`${file.status}:${file.path}`}>
                      {file.status} {file.path}
                    </code>
                  ))}
                  {diff.untrackedFiles.map((path) => (
                    <code key={`untracked:${path}`}>? {path}</code>
                  ))}
                </div>
                <pre className="diff-patch">{diff.patch || t("git.noDiff")}</pre>
                {diff.truncated ? <p>{t("git.truncated", { bytes: diff.originalBytes })}</p> : null}
              </section>

              <section className="review-card review-actions">
                <div>
                  <p className="fd-eyebrow">{t("git.delivery")}</p>
                  <h3>{t("git.deliveryTitle")}</h3>
                </div>
                <div className="button-row">
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void perform(async () => {
                        setReport(await window.forgedeck.deliveryReports.generate({ worktreeId }));
                      })
                    }
                  >
                    {t("git.generateReport")}
                  </button>
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void perform(async () => {
                        setMerge(await window.forgedeck.merges.prepare({ worktreeId }));
                      })
                    }
                  >
                    {t("git.prepareMerge")}
                  </button>
                  {pendingAction === "cleanup" ? (
                    <span className="confirm-row">
                      <button
                        className="danger-button"
                        disabled={busy || status.dirty || status.leased || status.gitLocked}
                        type="button"
                        onClick={() =>
                          void perform(async () => {
                            await window.forgedeck.worktrees.cleanup({
                              worktreeId,
                              confirmed: true
                            });
                            await loadWorktrees(selectedWorktree.projectId);
                            setMessage(t("git.cleanupDone"));
                          })
                        }
                      >
                        {t("git.confirmCleanup")}
                      </button>
                      <button type="button" onClick={() => setPendingAction(null)}>
                        {t("common.cancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      disabled={busy}
                      type="button"
                      onClick={() => setPendingAction("cleanup")}
                    >
                      {t("git.cleanup")}
                    </button>
                  )}
                </div>
                {report === null ? null : <pre className="report-preview">{report.markdown}</pre>}
                {merge === null ? null : (
                  <MergeConfirmation
                    busy={busy}
                    preview={merge}
                    onConfirm={() =>
                      void perform(async () => {
                        if (merge.confirmationToken === null) return;
                        const result = await window.forgedeck.merges.confirm({
                          planId: merge.plan.id,
                          confirmationToken: merge.confirmationToken,
                          confirmed: true
                        });
                        setMerge(null);
                        await loadReview(worktreeId);
                        setMessage(
                          result.state === "confirmed"
                            ? t("git.mergeConfirmed", {
                                rollback: result.rollbackCommand ?? t("common.unavailable")
                              })
                            : (result.error ?? t("git.mergeFailed"))
                        );
                      })
                    }
                  />
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function MergeConfirmation(input: {
  readonly preview: MergePreview;
  readonly busy: boolean;
  readonly onConfirm: () => void;
}) {
  const { t } = useI18n();
  const [typedBranch, setTypedBranch] = useState("");
  const { plan, confirmationToken } = input.preview;
  return (
    <div className="merge-confirmation">
      <strong>{t("git.preview", { source: plan.sourceBranch, target: plan.targetBranch })}</strong>
      {plan.issues.map((issue) => (
        <p className="error-message" key={issue}>
          {issue}
        </p>
      ))}
      {plan.conflictedFiles.map((file) => (
        <code key={file}>{t("git.conflict", { file })}</code>
      ))}
      {plan.eligible && confirmationToken !== null ? (
        <label>
          {t("git.typeConfirm", { branch: plan.sourceBranch })}
          <input value={typedBranch} onChange={(event) => setTypedBranch(event.target.value)} />
          <button
            className="danger-button"
            disabled={input.busy || typedBranch !== plan.sourceBranch}
            type="button"
            onClick={input.onConfirm}
          >
            {t("git.confirmMerge")}
          </button>
        </label>
      ) : null}
    </div>
  );
}
