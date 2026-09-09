import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";
import {
  AgentRuntime,
  RoleInjectionService,
  V2ProcessSupervisor
} from "@forgedeck/compazio-v2-runtime";
import {
  PipeProcessFactory,
  PlatformProcessTreeKiller,
  TransportProcessFactory
} from "@forgedeck/terminal";
import { afterEach, describe, expect, it } from "vitest";

import { isolatedTestEntitlement } from "./testing/isolated-entitlement";
import { V2WorkspaceService } from "./workspace-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V2 workspace service integration", () => {
  it("runs a real controlled process, receives output, then removes the terminal permanently", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-integration-"));
    roots.push(root);
    const supervisor = new V2ProcessSupervisor(
      new TransportProcessFactory({
        pty: new PipeProcessFactory(),
        pipe: new PipeProcessFactory()
      }),
      { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 100 }
    );
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const agents = new AgentRuntime({
      store: repository,
      roleInjection: new RoleInjectionService(join(root, "role-sessions"))
    });
    const service = new V2WorkspaceService({
      repository,
      entitlement: isolatedTestEntitlement(root),
      supervisor,
      agents
    });
    const output = new Promise<string>((resolve) => {
      service.subscribe((event) => {
        if (event.type === "terminal.output") resolve(event.data);
      });
    });
    const workspace = await service.create({ name: "V2", workingDirectory: process.cwd() });
    const configured = await service.addTerminal(workspace.id, {
      launchConfig: {
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.on('data', value => { process.stdout.write('received:' + value); process.exit(0); });"
        ],
        env: {},
        processMode: "pipe"
      }
    });
    const terminal = configured.nodes.find((node) => node.type === "terminal");
    if (terminal === undefined) throw new Error("terminal fixture missing");
    const session = await service.startTerminal(workspace.id, terminal.id);
    await service.writeTerminal(workspace.id, terminal.id, session.id, "hello");

    await expect(output).resolves.toContain("received:hello");
    await service.deleteNode(workspace.id, terminal.id);
    await expect(service.open(workspace.id)).resolves.toMatchObject({ nodes: [] });
    await service.shutdown();
  });

  it("separates a prompt paste from Enter with a real process-output barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-submit-integration-"));
    roots.push(root);
    const supervisor = new V2ProcessSupervisor(
      new TransportProcessFactory({
        pty: new PipeProcessFactory(),
        pipe: new PipeProcessFactory()
      }),
      { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 100 }
    );
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const agents = new AgentRuntime({
      store: repository,
      roleInjection: new RoleInjectionService(join(root, "role-sessions"))
    });
    const service = new V2WorkspaceService({
      repository,
      entitlement: isolatedTestEntitlement(root),
      supervisor,
      agents
    });
    const output: string[] = [];
    service.subscribe((event) => {
      if (event.type === "terminal.output") output.push(event.data);
    });
    const workspace = await service.create({ name: "Submit", workingDirectory: process.cwd() });
    const configured = await service.addTerminal(workspace.id, {
      launchConfig: {
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', value => { input += value; if (!input.includes('\\r')) { process.stdout.write('paste-redrawn'); return; } process.stdout.write('submitted:' + JSON.stringify(input)); process.exit(0); });"
        ],
        env: {},
        processMode: "pipe"
      }
    });
    const terminal = configured.nodes.find((node) => node.type === "terminal");
    if (terminal === undefined) throw new Error("terminal fixture missing");
    const session = await service.startTerminal(workspace.id, terminal.id);
    await service.submitTerminalInput(
      workspace.id,
      terminal.id,
      session.id,
      "\u001b[200~prompt\u001b[201~",
      ["\r"]
    );

    await waitFor(() => output.join("").includes("submitted:"));
    expect(output.join("")).toContain("paste-redrawn");
    expect(output.join("")).toContain("\\r");
    await service.shutdown();
  });

  it("fully submits a staged OpenCode connection envelope without a manual Enter", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-delivery-integration-"));
    roots.push(root);
    const supervisor = new V2ProcessSupervisor(
      new TransportProcessFactory({
        pty: new PipeProcessFactory(),
        pipe: new PipeProcessFactory()
      }),
      { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 100 }
    );
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const agents = new AgentRuntime({
      store: repository,
      roleInjection: new RoleInjectionService(join(root, "role-sessions"))
    });
    const service = new V2WorkspaceService({
      repository,
      entitlement: isolatedTestEntitlement(root),
      supervisor,
      agents
    });
    const output: string[] = [];
    service.subscribe((event) => {
      if (event.type === "terminal.output") output.push(event.data);
    });
    const workspace = await service.create({ name: "Delivery", workingDirectory: process.cwd() });
    const configured = await service.addTerminal(workspace.id, {
      agentConfig: { agentId: "opencode" },
      launchConfig: {
        command: process.execPath,
        args: [
          "-e",
          "let chunks=0,input=''; process.stdin.on('data', value => { chunks += 1; input += value; process.stdout.write('frame-' + chunks); if (chunks === 4) { process.stdout.write(':' + JSON.stringify(input)); process.exit(0); } });"
        ],
        env: {},
        processMode: "pipe"
      }
    });
    const terminal = configured.nodes.find((node) => node.type === "terminal");
    if (terminal?.type !== "terminal") throw new Error("terminal fixture missing");
    await service.startTerminal(workspace.id, terminal.id);
    await service.deliverConnectionPrompt(workspace.id, terminal.id, {
      pasteFrame: "\u001b[200~request\u001b[201~",
      submit: "\r"
    });

    await waitFor(() => output.join("").includes("frame-4:"));
    expect(output.join("")).toContain("\\r\\r\\r");
    await service.shutdown();
  });

  it("injects a role, replaces it on restart and cleans its session artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-roles-integration-"));
    roots.push(root);
    const supervisor = new V2ProcessSupervisor(
      new TransportProcessFactory({
        pty: new PipeProcessFactory(),
        pipe: new PipeProcessFactory()
      }),
      { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 100 }
    );
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const agents = new AgentRuntime({
      store: repository,
      roleInjection: new RoleInjectionService(join(root, "role-sessions"))
    });
    const service = new V2WorkspaceService({
      repository,
      supervisor,
      agents,
      entitlement: isolatedTestEntitlement(root)
    });
    const output: string[] = [];
    service.subscribe((event) => {
      if (event.type === "terminal.output") output.push(event.data);
    });
    const firstRole = await agents.createRole({
      name: "Primeiro",
      instructions: "RESPONSABILIDADE_UM"
    });
    const secondRole = await agents.createRole({
      name: "Segundo",
      instructions: "RESPONSABILIDADE_DOIS"
    });
    const workspace = await service.create({ name: "V2", workingDirectory: process.cwd() });
    const configured = await service.addTerminal(workspace.id, {
      agentConfig: { agentId: "custom", roleId: firstRole.id },
      launchConfig: {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(process.env.COMPAZIO_ROLE_INSTRUCTIONS || 'missing'); setInterval(() => {}, 1000);"
        ],
        env: {},
        processMode: "pipe"
      }
    });
    const terminal = configured.nodes.find((node) => node.type === "terminal");
    if (terminal === undefined) throw new Error("terminal fixture missing");
    const firstSession = await service.startTerminal(workspace.id, terminal.id);
    await waitFor(() => output.join("").includes("RESPONSABILIDADE_UM"));
    const updated = await service.updateNode(workspace.id, terminal.id, {
      agentConfig: { agentId: "custom", roleId: secondRole.id }
    });
    const updatedTerminal = updated.nodes.find((node) => node.id === terminal.id);
    expect(updatedTerminal).toMatchObject({
      type: "terminal",
      agentConfig: { roleId: secondRole.id }
    });
    const restarted = await service.restartTerminal(workspace.id, terminal.id, firstSession.id);
    expect(restarted.id).not.toBe(firstSession.id);
    await waitFor(() => output.join("").includes("RESPONSABILIDADE_DOIS"));
    await service.deleteNode(workspace.id, terminal.id);
    await expect(
      stat(join(root, "role-sessions", workspace.id, `${terminal.id}-${restarted.id}`))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await service.shutdown();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for controlled agent output");
}
