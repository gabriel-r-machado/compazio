import {
  addFilePreviewNode,
  addFileTreeNode,
  addNoteNode,
  addTerminalNode,
  addVisualEdge,
  createWorkspace,
  type DomainDependencies,
  type Workspace
} from "@forgedeck/compazio-v2-domain";

const fixtureTimestamp = "2026-08-25T12:00:00.000Z";

/** Reproducible persisted canvases used by restore and visual terminal acceptance. */
export function terminalWorkspaceFixtures(
  workingDirectory: string
): Readonly<Record<"A" | "B" | "C" | "D", Workspace>> {
  return {
    A: oneCodex(workingDirectory),
    B: codexAndBuilder(workingDirectory),
    C: completeTeam(workingDirectory),
    D: fiveTerminals(workingDirectory)
  };
}

function oneCodex(workingDirectory: string): Workspace {
  const dependencies = fixtureDependencies("a");
  let workspace = createWorkspace({ name: "Fixture A — Codex", workingDirectory }, dependencies);
  workspace = addTerminalNode(
    workspace,
    { title: "Codex", agentConfig: { agentId: "codex" }, position: { x: 80, y: 80 } },
    dependencies
  );
  return workspace;
}

function codexAndBuilder(workingDirectory: string): Workspace {
  const dependencies = fixtureDependencies("b");
  let workspace = createWorkspace(
    { name: "Fixture B — Codex + OpenCode", workingDirectory },
    dependencies
  );
  workspace = addTerminalNode(
    workspace,
    { title: "Codex", agentConfig: { agentId: "codex" }, position: { x: 80, y: 80 } },
    dependencies
  );
  workspace = addTerminalNode(
    workspace,
    {
      title: "OpenCode Builder",
      agentConfig: { agentId: "opencode", roleId: "developer" },
      position: { x: 780, y: 80 }
    },
    dependencies
  );
  return workspace;
}

function completeTeam(workingDirectory: string): Workspace {
  const dependencies = fixtureDependencies("c");
  let workspace = createWorkspace({ name: "Fixture C — Team", workingDirectory }, dependencies);
  workspace = addTerminalNode(
    workspace,
    {
      title: "Codex Coordinator",
      agentConfig: { agentId: "codex" },
      orchestrator: true,
      position: { x: 80, y: 80 }
    },
    dependencies
  );
  const coordinator = workspace.nodes.at(-1);
  if (coordinator?.type !== "terminal") throw new Error("Coordinator fixture is invalid");
  workspace = addTerminalNode(
    workspace,
    {
      title: "OpenCode Builder",
      agentConfig: { agentId: "opencode", roleId: "developer" },
      orchestratorOwnerNodeId: coordinator.id,
      position: { x: 780, y: 80 }
    },
    dependencies
  );
  const builder = workspace.nodes.at(-1);
  workspace = addTerminalNode(
    workspace,
    {
      title: "Codex Reviewer",
      agentConfig: { agentId: "codex", roleId: "reviewer" },
      orchestratorOwnerNodeId: coordinator.id,
      position: { x: 1_480, y: 80 }
    },
    dependencies
  );
  const reviewer = workspace.nodes.at(-1);
  workspace = addNoteNode(
    workspace,
    {
      title: "Mission",
      content: "Builder implements; Reviewer verifies.",
      position: { x: 80, y: 560 }
    },
    dependencies
  );
  const note = workspace.nodes.at(-1);
  workspace = addFileTreeNode(
    workspace,
    { title: "Files", position: { x: 440, y: 560 } },
    dependencies
  );
  workspace = addFilePreviewNode(
    workspace,
    {
      title: "Reference",
      filePath: "reference.png",
      previewKind: "image",
      position: { x: 800, y: 560 }
    },
    dependencies
  );
  const reference = workspace.nodes.at(-1);
  for (const target of [builder, reviewer, note, reference]) {
    if (target === undefined) throw new Error("Complete team fixture is invalid");
    workspace = addVisualEdge(workspace, coordinator.id, target.id, dependencies);
  }
  return workspace;
}

function fiveTerminals(workingDirectory: string): Workspace {
  const dependencies = fixtureDependencies("d");
  let workspace = createWorkspace(
    { name: "Fixture D — Five terminals", workingDirectory },
    dependencies
  );
  const agents = ["codex", "claude-code", "opencode", "shell", "custom"] as const;
  for (const [index, agentId] of agents.entries()) {
    workspace = addTerminalNode(
      workspace,
      {
        title: `Terminal ${index + 1} — ${agentId}`,
        agentConfig: { agentId },
        position: { x: 80 + (index % 3) * 700, y: 80 + Math.floor(index / 3) * 480 }
      },
      dependencies
    );
  }
  return workspace;
}

function fixtureDependencies(prefix: string): DomainDependencies {
  let nextId = 0;
  return {
    createId: () => `${prefix}_${++nextId}`,
    now: () => fixtureTimestamp
  };
}
