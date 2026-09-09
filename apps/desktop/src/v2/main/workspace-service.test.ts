import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Disposable,
  ManagedProcess,
  ManagedProcessFactory,
  ProcessTreeKiller,
  PtyExitEvent
} from "@forgedeck/terminal";
import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";
import {
  AgentRuntime,
  RoleInjectionService,
  V2ProcessSupervisor
} from "@forgedeck/compazio-v2-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isolatedTestEntitlement } from "./testing/isolated-entitlement";
import { V2WorkspaceService } from "./workspace-service";
import type { V2OrchestratorBridge } from "./workspace-service";

const roots: string[] = [];

class TestProcess implements ManagedProcess {
  public readonly pid = 456;
  public readonly write = vi.fn();
  public readonly endInput = vi.fn();
  public readonly requestCancel = vi.fn();
  public readonly resize = vi.fn();
  public readonly kill = vi.fn();
  public readonly dispose = vi.fn();
  public onData(listener: (data: string) => void): Disposable {
    return { dispose: () => void listener };
  }
  public onExit(listener: (event: PtyExitEvent) => void): Disposable {
    return { dispose: () => void listener };
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V2 workspace lifecycle", () => {
  it("stops a terminal, deletes its metadata and cannot restore it after reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-service-"));
    roots.push(root);
    const fakeProcess = new TestProcess();
    const factory: ManagedProcessFactory = { spawn: vi.fn(async () => fakeProcess) };
    const killer: ProcessTreeKiller = { kill: vi.fn(async () => undefined) };
    const supervisor = new V2ProcessSupervisor(factory, { treeKiller: killer, gracePeriodMs: 1 });
    let nextId = 0;
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const service = new V2WorkspaceService({
      repository,
      entitlement: isolatedTestEntitlement(root),
      supervisor,
      agents: new AgentRuntime({
        store: repository,
        roleInjection: new RoleInjectionService(join(root, "role-sessions"))
      }),
      createId: () => `id_${++nextId}`
    });

    const workspace = await service.create({
      name: "V2",
      workingDirectory: globalThis.process.cwd()
    });
    const withTerminal = await service.addTerminal(workspace.id, {});
    const terminal = withTerminal.nodes.find((node) => node.type === "terminal");
    if (terminal === undefined) throw new Error("terminal fixture missing");
    const session = await service.startTerminal(workspace.id, terminal.id);
    await service.deleteNode(workspace.id, terminal.id);

    const restored = await service.open(workspace.id);
    expect(fakeProcess.requestCancel).toHaveBeenCalledOnce();
    expect(killer.kill).toHaveBeenCalledWith(456);
    expect(restored.nodes).toEqual([]);
    expect(session.state).toBe("running");
  });

  it("does not inject a second bridge prompt into an advanced non-interactive launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-service-"));
    roots.push(root);
    const fakeProcess = new TestProcess();
    const factory: ManagedProcessFactory = { spawn: vi.fn(async () => fakeProcess) };
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const service = new V2WorkspaceService({
      repository,
      entitlement: isolatedTestEntitlement(root),
      supervisor: new V2ProcessSupervisor(factory, {
        treeKiller: { kill: vi.fn(async () => undefined) }
      }),
      agents: new AgentRuntime({
        store: repository,
        roleInjection: new RoleInjectionService(join(root, "role-sessions"))
      })
    });
    const bridge: V2OrchestratorBridge = {
      prepare: vi.fn(async () => ({
        environment: { COMPAZIO_BRIDGE_TOKEN: "test" },
        initialInput: ""
      })),
      revoke: vi.fn(async () => undefined)
    };
    service.setOrchestratorBridge(bridge);

    const workspace = await service.create({ name: "V2", workingDirectory: process.cwd() });
    const configured = await service.addTerminal(workspace.id, {
      orchestrator: true,
      agentConfig: { agentId: "codex" },
      launchConfig: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: {},
        processMode: "pipe"
      }
    });
    const terminal = configured.nodes.find((node) => node.type === "terminal");
    if (terminal === undefined) throw new Error("terminal fixture missing");

    await service.startTerminal(workspace.id, terminal.id);

    expect(bridge.prepare).toHaveBeenCalledOnce();
    expect(fakeProcess.write).not.toHaveBeenCalled();
    expect(factory.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: "pipe",
        environment: expect.objectContaining({
          TERM: "xterm-256color",
          COLORTERM: "truecolor"
        })
      })
    );
  });

  it("bootstraps a process-scoped MCP context for Claude and revokes it with the terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-service-"));
    roots.push(root);
    const fakeProcess = new TestProcess();
    const factory: ManagedProcessFactory = { spawn: vi.fn(async () => fakeProcess) };
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const service = new V2WorkspaceService({
      repository,
      entitlement: isolatedTestEntitlement(root),
      supervisor: new V2ProcessSupervisor(factory, {
        treeKiller: { kill: vi.fn(async () => undefined) }
      }),
      agents: new AgentRuntime({
        store: repository,
        roleInjection: new RoleInjectionService(join(root, "role-sessions"))
      })
    });
    const bridge: V2OrchestratorBridge = {
      prepare: vi.fn(async () => ({ environment: {}, initialInput: "" })),
      prepareAgentMcp: vi.fn(async () => ({
        environment: { COMPAZIO_MCP_TOKEN: "ephemeral" },
        args: ["--mcp-config", "temporary-config"]
      })),
      revoke: vi.fn(async () => undefined),
      revokeMcpSessionsForTerminal: vi.fn(async () => undefined)
    };
    service.setOrchestratorBridge(bridge);
    const workspace = await service.create({ name: "V2", workingDirectory: process.cwd() });
    const configured = await service.addTerminal(workspace.id, {
      agentConfig: { agentId: "claude-code" },
      launchConfig: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: {},
        processMode: "pipe"
      }
    });
    const terminal = configured.nodes.find((node) => node.type === "terminal");
    if (terminal === undefined) throw new Error("terminal fixture missing");

    await service.startTerminal(workspace.id, terminal.id);
    await service.deleteNode(workspace.id, terminal.id);

    expect(bridge.prepareAgentMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({ id: workspace.id }),
        terminal: expect.objectContaining({ id: terminal.id })
      })
    );
    expect(factory.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["--mcp-config", "temporary-config", "-e", "setInterval(() => {}, 1000)"],
        environment: expect.objectContaining({ COMPAZIO_MCP_TOKEN: "ephemeral" })
      })
    );
    expect(bridge.revokeMcpSessionsForTerminal).toHaveBeenCalledWith(terminal.id);
  });

  it("fails closed when a coding-agent security bootstrap cannot be prepared", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-service-"));
    roots.push(root);
    const factory: ManagedProcessFactory = {
      spawn: vi.fn(async () => new TestProcess())
    };
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const service = new V2WorkspaceService({
      repository,
      entitlement: isolatedTestEntitlement(root),
      supervisor: new V2ProcessSupervisor(factory, {
        treeKiller: { kill: vi.fn(async () => undefined) }
      }),
      agents: new AgentRuntime({
        store: repository,
        roleInjection: new RoleInjectionService(join(root, "role-sessions"))
      })
    });
    const bridge: V2OrchestratorBridge = {
      prepare: vi.fn(async () => ({ environment: {}, initialInput: "" })),
      prepareAgentMcp: vi.fn(async () => {
        throw new Error("skill isolation unavailable");
      }),
      revoke: vi.fn(async () => undefined),
      revokeMcpSessionsForTerminal: vi.fn(async () => undefined)
    };
    service.setOrchestratorBridge(bridge);
    const workspace = await service.create({ name: "V2", workingDirectory: process.cwd() });
    const configured = await service.addTerminal(workspace.id, {
      agentConfig: { agentId: "codex" },
      launchConfig: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: {},
        processMode: "pipe"
      }
    });
    const terminal = configured.nodes.find((node) => node.type === "terminal");
    if (terminal === undefined) throw new Error("terminal fixture missing");

    await expect(service.startTerminal(workspace.id, terminal.id)).rejects.toThrow(
      "skill isolation unavailable"
    );
    expect(factory.spawn).not.toHaveBeenCalled();
    expect(bridge.revoke).toHaveBeenCalled();
  });

  it("serializes concurrent resize and edge mutations without losing either update", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-service-"));
    roots.push(root);
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const service = new V2WorkspaceService({
      repository,
      entitlement: isolatedTestEntitlement(root),
      supervisor: new V2ProcessSupervisor(
        { spawn: vi.fn(async () => new TestProcess()) },
        { treeKiller: { kill: vi.fn(async () => undefined) } }
      ),
      agents: new AgentRuntime({
        store: repository,
        roleInjection: new RoleInjectionService(join(root, "role-sessions"))
      })
    });
    const workspace = await service.create({ name: "V2", workingDirectory: process.cwd() });
    const withTerminal = await service.addTerminal(workspace.id, { title: "Terminal" });
    const terminal = withTerminal.nodes.find((node) => node.type === "terminal");
    if (terminal === undefined) throw new Error("terminal fixture missing");
    const withNote = await service.addNote(workspace.id, { title: "Nota" });
    const note = withNote.nodes.find((node) => node.type === "note");
    if (note === undefined) throw new Error("note fixture missing");

    await Promise.all([
      service.resizeNode(workspace.id, terminal.id, { width: 420, height: 240 }),
      service.addEdge(workspace.id, terminal.id, note.id, ["read-note"])
    ]);

    const restored = await service.open(workspace.id);
    expect(restored.nodes.find((node) => node.id === terminal.id)?.size).toEqual({
      width: 420,
      height: 240
    });
    expect(restored.edges).toContainEqual(
      expect.objectContaining({ sourceNodeId: terminal.id, targetNodeId: note.id })
    );
  });

  it("undoes and redoes one durable canvas action without recording viewport-only changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-service-"));
    roots.push(root);
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const service = new V2WorkspaceService({
      repository,
      entitlement: isolatedTestEntitlement(root),
      supervisor: new V2ProcessSupervisor(
        { spawn: vi.fn(async () => new TestProcess()) },
        { treeKiller: { kill: vi.fn(async () => undefined) } }
      ),
      agents: new AgentRuntime({
        store: repository,
        roleInjection: new RoleInjectionService(join(root, "role-sessions"))
      })
    });
    const workspace = await service.create({ name: "Histórico", workingDirectory: process.cwd() });
    const withNote = await service.addNote(workspace.id, { title: "Plano" });
    const note = withNote.nodes.find((node) => node.type === "note");
    if (note?.type !== "note") throw new Error("note fixture missing");
    await service.updateSettings(workspace.id, {
      ...withNote.settings,
      viewport: { x: 120, y: 40, zoom: 0.8 }
    });
    await service.updateNode(workspace.id, note.id, { content: "- [ ] entregar" });

    const undone = await service.undo(workspace.id);
    expect(undone.nodes.find((node) => node.id === note.id)).toMatchObject({ content: "" });
    expect(undone.settings.viewport).toEqual({ x: 120, y: 40, zoom: 0.8 });

    const redone = await service.redo(workspace.id);
    expect(redone.nodes.find((node) => node.id === note.id)).toMatchObject({
      content: "- [ ] entregar"
    });
  });

  it("preserves both near-simultaneous collaborative note appends and checklist state after reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-service-"));
    roots.push(root);
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const service = new V2WorkspaceService({
      repository,
      entitlement: isolatedTestEntitlement(root),
      supervisor: new V2ProcessSupervisor(
        { spawn: vi.fn(async () => new TestProcess()) },
        { treeKiller: { kill: vi.fn(async () => undefined) } }
      ),
      agents: new AgentRuntime({
        store: repository,
        roleInjection: new RoleInjectionService(join(root, "role-sessions"))
      })
    });
    const workspace = await service.create({ name: "Notas", workingDirectory: process.cwd() });
    const withNote = await service.addNote(workspace.id, {
      title: "Plano",
      content:
        "# Plano de execu\u00e7\u00e3o\n\n- [ ] Implementar\n- [ ] Revisar\n- [ ] Corrigir\n- [ ] Aprovar"
    });
    const note = withNote.nodes.find((node) => node.type === "note");
    if (note?.type !== "note") throw new Error("note fixture missing");

    await Promise.all([
      service.appendToNote(workspace.id, note.id, "## Implementa\u00e7\u00e3o"),
      service.appendToNote(workspace.id, note.id, "## Revis\u00e3o")
    ]);
    await service.setNoteChecklistItem(workspace.id, note.id, 2, true);
    const restored = await service.open(workspace.id);
    expect(restored.nodes.find((node) => node.id === note.id)).toMatchObject({
      content: expect.stringContaining("## Implementa\u00e7\u00e3o")
    });
    expect(restored.nodes.find((node) => node.id === note.id)).toMatchObject({
      content: expect.stringContaining("## Revis\u00e3o")
    });
    expect(restored.nodes.find((node) => node.id === note.id)).toMatchObject({
      content: expect.stringContaining("- [x] Implementar")
    });
  });

  it("mirrors notes as atomic Markdown files and reloads external edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-service-"));
    roots.push(root);
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    const repository = new V2WorkspaceRepository({ rootDirectory: join(root, "repository") });
    const service = new V2WorkspaceService({
      repository,
      entitlement: isolatedTestEntitlement(root),
      supervisor: new V2ProcessSupervisor(
        { spawn: vi.fn(async () => new TestProcess()) },
        { treeKiller: { kill: vi.fn(async () => undefined) } }
      ),
      agents: new AgentRuntime({
        store: repository,
        roleInjection: new RoleInjectionService(join(root, "role-sessions"))
      }),
      notesAsMarkdown: true
    });
    const workspace = await service.create({ name: "Notas", workingDirectory: project });
    const withNote = await service.addNote(workspace.id, {
      title: "Plano",
      content: "# Inicial"
    });
    const note = withNote.nodes.find((node) => node.type === "note");
    if (note?.type !== "note") throw new Error("note fixture missing");
    const notePath = join(project, ".compazio", "notes", `${note.id}.md`);

    expect(await readFile(notePath, "utf8")).toBe("# Inicial");
    await writeFile(notePath, "# Editado externamente", "utf8");
    const hydrated = await service.open(workspace.id);
    expect(hydrated.nodes.find((node) => node.id === note.id)).toMatchObject({
      content: "# Editado externamente"
    });

    await service.appendToNote(workspace.id, note.id, "## Apêndice");
    expect(await readFile(notePath, "utf8")).toContain("## Apêndice");
  });
});
