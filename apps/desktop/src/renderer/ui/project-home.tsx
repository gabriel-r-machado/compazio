import { useState } from "react";

import type { GitProjectDto } from "@forgedeck/schemas";

import type { CanvasTemplateId } from "./canvas-store";
import { useI18n } from "./i18n";

interface ProjectHomeProps {
  readonly projects: readonly GitProjectDto[];
  readonly selectedProjectId: string | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onOpenProject: () => void;
  readonly onCloneGitHub: (repositoryUrl: string) => void;
  readonly onSelectProject: (projectId: string) => void;
  readonly onStartTemplate: (templateId: CanvasTemplateId) => void;
}

export function ProjectHome(props: ProjectHomeProps) {
  const { t } = useI18n();
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const templates: readonly {
    readonly id: CanvasTemplateId;
    readonly title: string;
    readonly description: string;
  }[] = [
    {
      id: "empty",
      title: t("projectHome.emptyTemplate"),
      description: t("projectHome.emptyTemplateBody")
    },
    {
      id: "blueprint-to-pr",
      title: t("projectHome.blueprintTemplate"),
      description: t("projectHome.blueprintTemplateBody")
    },
    {
      id: "bugfix",
      title: t("projectHome.bugfixTemplate"),
      description: t("projectHome.bugfixTemplateBody")
    },
    {
      id: "landing-page",
      title: t("projectHome.landingTemplate"),
      description: t("projectHome.landingTemplateBody")
    },
    {
      id: "saas",
      title: t("projectHome.saasTemplate"),
      description: t("projectHome.saasTemplateBody")
    },
    {
      id: "system",
      title: t("projectHome.systemTemplate"),
      description: t("projectHome.systemTemplateBody")
    }
  ];
  return (
    <section className="project-home" aria-label={t("projectHome.aria")}>
      <header className="project-home-header">
        <div>
          <p className="fd-eyebrow">{t("projectHome.eyebrow")}</p>
          <h2>{t("projectHome.title")}</h2>
          <p>{t("projectHome.body")}</p>
        </div>
        <button
          className="primary-button"
          disabled={props.busy}
          type="button"
          onClick={props.onOpenProject}
        >
          {props.busy ? t("common.opening") : t("projectHome.open")}
        </button>
      </header>

      {props.error === null ? null : <p className="review-notice is-error">{props.error}</p>}

      <div className="project-home-grid">
        <section className="project-home-card" aria-labelledby="recent-projects-title">
          <div className="card-heading">
            <div>
              <p className="fd-eyebrow">{t("projectHome.projects")}</p>
              <h3 id="recent-projects-title">{t("projectHome.recent")}</h3>
            </div>
          </div>
          {props.projects.length === 0 ? (
            <p className="empty-projects">{t("projectHome.empty")}</p>
          ) : (
            <div className="project-list">
              {props.projects.map((project) => (
                <button
                  className={
                    props.selectedProjectId === project.id
                      ? "project-list-item is-active"
                      : "project-list-item"
                  }
                  key={project.id}
                  type="button"
                  onClick={() => props.onSelectProject(project.id)}
                >
                  <span>{project.name}</span>
                  <small>{project.defaultBranch}</small>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="project-home-card" aria-labelledby="templates-title">
          <div className="card-heading">
            <div>
              <p className="fd-eyebrow">{t("projectHome.canvas")}</p>
              <h3 id="templates-title">{t("projectHome.templatesTitle")}</h3>
            </div>
          </div>
          <div className="template-list">
            {templates.map((template) => (
              <button
                disabled={props.selectedProjectId === null}
                key={template.id}
                type="button"
                onClick={() => props.onStartTemplate(template.id)}
              >
                <strong>{template.title}</strong>
                <span>{template.description}</span>
              </button>
            ))}
          </div>
          {props.selectedProjectId === null ? (
            <p className="template-hint">{t("projectHome.selectFirst")}</p>
          ) : null}
        </section>
        <section className="project-home-card" aria-labelledby="clone-github-title">
          <p className="fd-eyebrow">GitHub</p>
          <h3 id="clone-github-title">{t("projectHome.cloneTitle")}</h3>
          <form
            className="project-clone-form"
            onSubmit={(event) => {
              event.preventDefault();
              props.onCloneGitHub(repositoryUrl);
            }}
          >
            <label>
              {t("projectHome.cloneLabel")}
              <input
                autoComplete="off"
                disabled={props.busy}
                inputMode="url"
                placeholder="https://github.com/owner/repository.git"
                required
                type="url"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
              />
            </label>
            <p className="template-hint">{t("projectHome.cloneBody")}</p>
            <button disabled={props.busy} type="submit">
              {t("projectHome.cloneAction")}
            </button>
          </form>
        </section>
      </div>
    </section>
  );
}
