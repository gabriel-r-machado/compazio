import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ORCHESTRATOR_TEAM_PERMISSIONS } from "@forgedeck/schemas";
import type { WorkspaceAgentContext, WorkspaceContextSource } from "@forgedeck/schemas";

import {
  buildTerminalContextPrompt,
  releaseTerminalContext,
  stageTerminalContext,
  sweepTerminalContexts,
  type TerminalContextStore
} from "./terminal-context-staging";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true }));
});

function tempProjectRoot(nameHint: string): string {
  const directory = mkdtempSync(join(tmpdir(), `compazio-staging-${nameHint}-`));
  directories.push(directory);
  return directory;
}

function fakeStore(mission: string, sources: WorkspaceContextSource[]): TerminalContextStore {
  const context: WorkspaceAgentContext = {
    workspaceId: "workspace-1",
    agentNodeId: "terminal-1",
    mission,
    permissions: [],
    sources
  };
  return { resolve: () => context };
}

const baseContract = {
  schemaVersion: "1.0" as const,
  kind: "context" as const,
  label: "context",
  requiredEvidenceTypes: []
};

describe("stageTerminalContext", () => {
  it("puts the full note content into the prompt", () => {
    const projectRoot = tempProjectRoot("note");
    const store = fakeStore("Lançar a landing page", [
      {
        nodeId: "note-1",
        title: "Briefing",
        kind: "note",
        content: "Público-alvo: pequenas empresas. Tom: direto.",
        inclusion: "relevant",
        edgeId: "edge-1",
        contract: baseContract
      }
    ]);

    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-1",
      contextStore: store
    });

    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("unreachable");
    expect(staged.notes).toEqual([
      {
        nodeId: "note-1",
        title: "Briefing",
        content: "Público-alvo: pequenas empresas. Tom: direto."
      }
    ]);
    const prompt = buildTerminalContextPrompt(staged);
    expect(prompt).toContain("Público-alvo: pequenas empresas. Tom: direto.");
    expect(prompt).toContain("Lançar a landing page");
  });

  it("stages an inline image into inputs/, records it in the manifest, and cites its absolute path", () => {
    const projectRoot = tempProjectRoot("image");
    const pngBytes = Buffer.from("fake-png-bytes");
    const store = fakeStore("", [
      {
        nodeId: "image-1",
        title: "Foto do produto",
        kind: "image",
        inclusion: "relevant",
        edgeId: "edge-1",
        contract: baseContract,
        reference: {
          kind: "image",
          filename: "product.png",
          mediaType: "image/png",
          previewDataUri: `data:image/png;base64,${pngBytes.toString("base64")}`
        }
      }
    ]);

    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-2",
      contextStore: store
    });

    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("unreachable");
    expect(staged.attachments).toHaveLength(1);
    const attachment = staged.attachments[0];
    expect(attachment).toBeDefined();
    if (attachment === undefined) throw new Error("unreachable");
    expect(attachment.filename).toBe("product.png");
    expect(existsSync(attachment.stagedPath)).toBe(true);
    expect(readFileSync(attachment.stagedPath)).toEqual(pngBytes);

    const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8")) as {
      attachments: readonly { filename: string; stagedPath: string }[];
    };
    expect(manifest.attachments).toHaveLength(1);
    expect(manifest.attachments[0]?.stagedPath).toBe(attachment.stagedPath);

    const prompt = buildTerminalContextPrompt(staged);
    expect(prompt).toContain(attachment.stagedPath);
  });

  it("copies a published artifact from the project (an upstream terminal's delivery)", () => {
    const projectRoot = tempProjectRoot("artifact");
    const artifactDirectory = join(projectRoot, ".forgedeck", "artifacts", "report");
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(join(artifactDirectory, "review.json"), '{"status":"ok"}');

    const store = fakeStore("", [
      {
        nodeId: "artifact-1",
        title: "review.json",
        kind: "artifact",
        inclusion: "relevant",
        edgeId: "edge-1",
        contract: baseContract,
        artifact: {
          id: "00000000-0000-4000-8000-000000000010",
          kind: "review",
          relativePath: ".forgedeck/artifacts/report/review.json",
          filename: "review.json",
          sha256: "a".repeat(64),
          byteSize: 15,
          mediaType: "application/json"
        }
      }
    ]);

    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-3",
      contextStore: store
    });

    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("unreachable");
    expect(staged.attachments).toHaveLength(1);
    const attachment = staged.attachments[0];
    expect(attachment?.filename).toBe("review.json");
    expect(attachment && readFileSync(attachment.stagedPath, "utf8")).toBe('{"status":"ok"}');
  });

  it("stages two attachments and renames a duplicate filename without overwriting", () => {
    const projectRoot = tempProjectRoot("dedupe");
    const dataUri = (text: string) =>
      `data:image/png;base64,${Buffer.from(text).toString("base64")}`;
    const store = fakeStore("", [
      {
        nodeId: "image-1",
        title: "Foto 1",
        kind: "image",
        inclusion: "relevant",
        edgeId: "edge-1",
        contract: baseContract,
        reference: { kind: "image", filename: "photo.png", previewDataUri: dataUri("first") }
      },
      {
        nodeId: "image-2",
        title: "Foto 2",
        kind: "image",
        inclusion: "relevant",
        edgeId: "edge-2",
        contract: baseContract,
        reference: { kind: "image", filename: "photo.png", previewDataUri: dataUri("second") }
      }
    ]);

    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-4",
      contextStore: store
    });

    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("unreachable");
    expect(staged.attachments).toHaveLength(2);
    const filenames = staged.attachments.map((attachment) => attachment.filename);
    expect(new Set(filenames).size).toBe(2);
    expect(filenames).toContain("photo.png");
    expect(filenames.some((name) => name === "photo-2.png")).toBe(true);
    expect(readFileSync(join(staged.inputsDirectory, "photo.png"), "utf8")).toBe("first");
    expect(readFileSync(join(staged.inputsDirectory, "photo-2.png"), "utf8")).toBe("second");
  });

  it("works with a project root containing spaces and accents", () => {
    const base = tempProjectRoot("acentos");
    const projectRoot = join(base, "Projeto com espaços e acentuação");
    mkdirSync(projectRoot, { recursive: true });
    const store = fakeStore("", [
      {
        nodeId: "image-1",
        title: "Imagem",
        kind: "image",
        inclusion: "relevant",
        edgeId: "edge-1",
        contract: baseContract,
        reference: {
          kind: "image",
          filename: "logotipo.png",
          previewDataUri: `data:image/png;base64,${Buffer.from("bytes").toString("base64")}`
        }
      }
    ]);

    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-5",
      contextStore: store
    });

    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("unreachable");
    expect(existsSync(staged.attachments[0]?.stagedPath ?? "")).toBe(true);
  });

  it("blocks staging with an actionable message when a file/folder source has no bytes", () => {
    const projectRoot = tempProjectRoot("unavailable");
    const store = fakeStore("", [
      {
        nodeId: "file-1",
        title: "Especificação.pdf",
        kind: "file",
        inclusion: "relevant",
        edgeId: "edge-1",
        contract: baseContract,
        reference: { kind: "file" }
      }
    ]);

    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-6",
      contextStore: store
    });

    expect(staged.ok).toBe(false);
    if (staged.ok) throw new Error("unreachable");
    expect(staged.reason).toContain("Especificação.pdf");
    expect(existsSync(join(projectRoot, ".compazio"))).toBe(false);
  });

  it("blocks staging when a published artifact's file no longer exists on disk", () => {
    const projectRoot = tempProjectRoot("missing-artifact");
    const store = fakeStore("", [
      {
        nodeId: "artifact-1",
        title: "review.json",
        kind: "artifact",
        inclusion: "relevant",
        edgeId: "edge-1",
        contract: baseContract,
        artifact: {
          id: "00000000-0000-4000-8000-000000000011",
          kind: "review",
          relativePath: ".forgedeck/artifacts/report/missing.json",
          filename: "missing.json",
          sha256: "b".repeat(64),
          byteSize: 2,
          mediaType: "application/json"
        }
      }
    ]);

    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-7",
      contextStore: store
    });

    expect(staged.ok).toBe(false);
    if (staged.ok) throw new Error("unreachable");
    expect(staged.reason).toContain("review.json");
  });

  it("cleans up a partially staged run directory when writing an attachment fails", () => {
    const projectRoot = tempProjectRoot("cancel");
    // A source that passes the availability check (image with a data URI) but whose target
    // filename collides with a pre-existing *directory* of the same name, so the write fails.
    const runDirectory = join(projectRoot, ".compazio", "runs", "session-8", "inputs");
    mkdirSync(join(runDirectory, "photo.png"), { recursive: true });
    const store = fakeStore("", [
      {
        nodeId: "image-1",
        title: "Foto",
        kind: "image",
        inclusion: "relevant",
        edgeId: "edge-1",
        contract: baseContract,
        reference: {
          kind: "image",
          filename: "photo.png",
          previewDataUri: `data:image/png;base64,${Buffer.from("bytes").toString("base64")}`
        }
      }
    ]);

    expect(() =>
      stageTerminalContext({
        workspaceId: "workspace-1",
        nodeId: "terminal-1",
        projectRoot,
        sessionId: "session-8",
        contextStore: store
      })
    ).toThrow();
    expect(existsSync(join(projectRoot, ".compazio", "runs", "session-8"))).toBe(false);
  });

  it("opens the prompt with the responsibility the terminal was given", () => {
    const projectRoot = tempProjectRoot("role");
    const context: WorkspaceAgentContext = {
      workspaceId: "workspace-1",
      agentNodeId: "terminal-1",
      mission: "Lançar a landing page",
      permissions: [],
      role: {
        name: "Revisor",
        responsibilities: "Revisar cada diff antes da entrega",
        constraints: "Nunca faz merge",
        expectedDeliverable: "Lista de regressões",
        completionCriteria: "Todo arquivo alterado foi revisado"
      },
      sources: [noteSource("Briefing", "Use tom direto.")]
    };

    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-role",
      contextStore: { resolve: () => context }
    });

    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("unreachable");
    const prompt = buildTerminalContextPrompt(staged);
    expect(prompt).toContain("## Seu papel: Revisor");
    expect(prompt).toContain("Responsabilidades: Revisar cada diff antes da entrega");
    expect(prompt).toContain("Restrições: Nunca faz merge");
    expect(prompt).toContain("Critério de conclusão: Todo arquivo alterado foi revisado");
    // The role frames how the materials are read, so it comes first.
    expect(prompt.indexOf("Seu papel")).toBeLessThan(prompt.indexOf("Use tom direto."));
  });

  it("says nothing about a role a terminal does not have", () => {
    const projectRoot = tempProjectRoot("no-role");
    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-no-role",
      contextStore: fakeStore("", [noteSource("Briefing", "conteúdo")])
    });

    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("unreachable");
    expect(staged.role).toBeUndefined();
    expect(buildTerminalContextPrompt(staged)).not.toContain("Seu papel");
  });

  it("leaves out a role field the user left blank", () => {
    const projectRoot = tempProjectRoot("partial-role");
    const context: WorkspaceAgentContext = {
      workspaceId: "workspace-1",
      agentNodeId: "terminal-1",
      mission: "",
      permissions: [],
      role: {
        name: "Testador",
        responsibilities: "Escrever cobertura",
        constraints: "",
        expectedDeliverable: "",
        completionCriteria: ""
      },
      sources: []
    };

    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-partial-role",
      contextStore: { resolve: () => context }
    });

    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("unreachable");
    const prompt = buildTerminalContextPrompt(staged);
    expect(prompt).toContain("Responsabilidades: Escrever cobertura");
    expect(prompt).not.toContain("Restrições:");
    expect(prompt).not.toContain("Entrega esperada:");
  });

  it("tells an orchestrator how to build its team, and says nothing about it to everyone else", () => {
    const teammate = fakeStore("Implementar autenticação", []);
    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot: tempProjectRoot("teammate"),
      sessionId: "session-teammate",
      contextStore: teammate
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("unreachable");
    // An agent that cannot recruit is never taught to: the Policy Engine would deny every attempt,
    // and a terminal arguing with a denial is worse than one that never tried.
    expect(buildTerminalContextPrompt(staged)).not.toContain("compazio terminal create");

    const context: WorkspaceAgentContext = {
      workspaceId: "workspace-1",
      agentNodeId: "terminal-1",
      mission: "Implementar autenticação",
      permissions: [...ORCHESTRATOR_TEAM_PERMISSIONS],
      sources: []
    };
    const orchestrator = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot: tempProjectRoot("orchestrator"),
      sessionId: "session-orchestrator",
      contextStore: { resolve: () => context }
    });
    expect(orchestrator.ok).toBe(true);
    if (!orchestrator.ok) throw new Error("unreachable");
    const prompt = buildTerminalContextPrompt(orchestrator);
    expect(prompt).toContain("compazio terminal create");
    expect(prompt).toContain("--from terminal-1");
    // The mission still frames the work; the team surface is an addition, not a replacement.
    expect(prompt).toContain("Implementar autenticação");
    // The runtimes offered are the ones the spawn path actually accepts, not every adapter that exists.
    expect(prompt).toContain("claude-code, codex");
    // A quiet terminal is not a finished one — the instructions must keep saying so.
    expect(prompt).toContain("Um terminal em silêncio não é");
  });

  it("keeps staged material out of the user's version control", () => {
    const projectRoot = tempProjectRoot("ignore");
    const store = fakeStore("", [noteSource("Briefing", "conteúdo")]);

    stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-9",
      contextStore: store
    });

    // Only the ephemeral staging is ignored. Notes live under the same root and stay versionable,
    // because a briefing is the user's own content.
    expect(readFileSync(join(projectRoot, ".compazio", ".gitignore"), "utf8").trim()).toBe("runs/");
  });

  it("does not overwrite an ignore file the user already wrote", () => {
    const projectRoot = tempProjectRoot("ignore-existing");
    mkdirSync(join(projectRoot, ".compazio"), { recursive: true });
    writeFileSync(join(projectRoot, ".compazio", ".gitignore"), "runs/\n", "utf8");
    const store = fakeStore("", [noteSource("Briefing", "conteúdo")]);

    stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-10",
      contextStore: store
    });

    expect(readFileSync(join(projectRoot, ".compazio", ".gitignore"), "utf8")).toBe("runs/\n");
  });
});

describe("releaseTerminalContext", () => {
  it("removes the session's staged copies of the user's material", () => {
    const projectRoot = tempProjectRoot("release");
    const store = fakeStore("", [imageSource("Foto", "photo.png")]);
    const staged = stageTerminalContext({
      workspaceId: "workspace-1",
      nodeId: "terminal-1",
      projectRoot,
      sessionId: "session-11",
      contextStore: store
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("unreachable");
    const attachment = staged.attachments[0];
    if (attachment === undefined) throw new Error("unreachable");
    expect(existsSync(attachment.stagedPath)).toBe(true);

    releaseTerminalContext({ projectRoot, sessionId: "session-11" });

    expect(existsSync(join(projectRoot, ".compazio", "runs", "session-11"))).toBe(false);
    // Nothing of ours is left behind once the last session is gone.
    expect(existsSync(join(projectRoot, ".compazio"))).toBe(false);
  });

  it("leaves another live session's staging untouched", () => {
    const projectRoot = tempProjectRoot("release-sibling");
    const store = fakeStore("", [noteSource("Briefing", "conteúdo")]);
    for (const sessionId of ["session-12", "session-13"]) {
      stageTerminalContext({
        workspaceId: "workspace-1",
        nodeId: "terminal-1",
        projectRoot,
        sessionId,
        contextStore: store
      });
    }

    releaseTerminalContext({ projectRoot, sessionId: "session-12" });

    expect(existsSync(join(projectRoot, ".compazio", "runs", "session-12"))).toBe(false);
    expect(existsSync(join(projectRoot, ".compazio", "runs", "session-13"))).toBe(true);
  });

  it("is a no-op for a session that never staged anything", () => {
    const projectRoot = tempProjectRoot("release-empty");

    expect(() => releaseTerminalContext({ projectRoot, sessionId: "session-14" })).not.toThrow();
    expect(existsSync(join(projectRoot, ".compazio"))).toBe(false);
  });
});

describe("sweepTerminalContexts", () => {
  it("removes staging a crash left behind and keeps what a live session owns", () => {
    const projectRoot = tempProjectRoot("sweep");
    const store = fakeStore("", [noteSource("Briefing", "conteúdo")]);
    for (const sessionId of ["dead-1", "dead-2", "alive-1"]) {
      stageTerminalContext({
        workspaceId: "workspace-1",
        nodeId: "terminal-1",
        projectRoot,
        sessionId,
        contextStore: store
      });
    }

    const removed = sweepTerminalContexts({ projectRoot, activeSessionIds: ["alive-1"] });

    expect(removed).toBe(2);
    expect(existsSync(join(projectRoot, ".compazio", "runs", "dead-1"))).toBe(false);
    expect(existsSync(join(projectRoot, ".compazio", "runs", "dead-2"))).toBe(false);
    expect(existsSync(join(projectRoot, ".compazio", "runs", "alive-1"))).toBe(true);
  });

  it("reports nothing removed for a project that never staged anything", () => {
    const projectRoot = tempProjectRoot("sweep-empty");

    expect(sweepTerminalContexts({ projectRoot, activeSessionIds: [] })).toBe(0);
  });
});

function noteSource(title: string, content: string): WorkspaceContextSource {
  return {
    nodeId: `note-${title}`,
    title,
    kind: "note",
    content,
    inclusion: "relevant",
    edgeId: `edge-${title}`,
    contract: baseContract
  };
}

function imageSource(title: string, filename: string): WorkspaceContextSource {
  return {
    nodeId: `image-${title}`,
    title,
    kind: "image",
    inclusion: "relevant",
    edgeId: `edge-${title}`,
    contract: baseContract,
    reference: {
      kind: "image",
      filename,
      previewDataUri: `data:image/png;base64,${Buffer.from("bytes").toString("base64")}`
    }
  };
}
