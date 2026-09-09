import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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

import { V2OrchestratorBridge } from "./orchestrator-bridge";
import { isolatedTestEntitlement } from "./testing/isolated-entitlement";
import { V2WorkspaceService } from "./workspace-service";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const windowsIt = process.platform === "win32" ? it : it.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Compazio connection bridge", () => {
  it("prepara CLI e instruções para todo coding agent sem preencher a entrada", async () => {
    const fixture = await createFixture();
    try {
      const workspace = await fixture.workspaces.create({
        name: "Protocol",
        workingDirectory: process.cwd()
      });
      const configured = await fixture.workspaces.addTerminal(workspace.id, {
        title: "Codex",
        agentConfig: { agentId: "codex" }
      });
      const terminal = configured.nodes.find((node) => node.type === "terminal");
      if (terminal?.type !== "terminal") throw new Error("terminal fixture missing");
      const context = await fixture.bridge.prepare({
        workspace: configured,
        terminal,
        sessionId: "session-1"
      });
      const launch = await fixture.bridge.prepareAgentMcp({
        workspace: configured,
        terminal,
        sessionId: "session-1"
      });

      expect(context.initialInput).toBe("");
      expect(context.environment.COMPAZIO_ORCHESTRATOR).toBe("false");
      expect(context.environment.COMPAZIO_BRIDGE_CLI).toContain("compazio");
      const protocol = await readFile(context.environment.COMPAZIO_PROTOCOL ?? "", "utf8");
      expect(protocol).toContain("compazio send");
      expect(protocol).toContain("compazio reply");
      expect(protocol).toContain("compazio inbox");
      expect(protocol).not.toContain("team_run_create");
      expect(launch?.args.join(" ")).toContain("developer_instructions");
      expect(launch?.args).not.toContain("--sandbox");
    } finally {
      await fixture.shutdown();
    }
  });

  windowsIt(
    "executa o CLI de sessão no Windows sem iniciar Electron",
    async () => {
      const fixture = await createFixture();
      fixture.bridge.prepareAgentMcp = async () => undefined;
      try {
        const workspace = await fixture.workspaces.create({
          name: "Windows CLI",
          workingDirectory: process.cwd()
        });
        const configured = await fixture.workspaces.addTerminal(workspace.id, {
          title: "Codex local",
          agentConfig: { agentId: "codex" },
          launchConfig: testProcessLaunch()
        });
        const terminal = configured.nodes.find((node) => node.type === "terminal");
        if (terminal?.type !== "terminal") throw new Error("terminal fixture missing");
        const session = await fixture.workspaces.startTerminal(workspace.id, terminal.id);
        const internals = fixture.bridge as unknown as {
          readonly endpoint: string;
          readonly sessionsById: ReadonlyMap<
            string,
            { readonly token: string; readonly shimDirectory: string }
          >;
        };
        const bridgeSession = internals.sessionsById.get(session.id);
        if (bridgeSession === undefined) throw new Error("bridge session fixture missing");
        const cli = join(bridgeSession.shimDirectory, "compazio.cmd");
        const shim = await readFile(cli, "utf8");
        const powershellShim = await readFile(
          join(bridgeSession.shimDirectory, "compazio.ps1"),
          "utf8"
        );
        expect(shim).not.toContain("electron");
        expect(shim).not.toContain("COMPAZIO_BRIDGE_NODE");
        expect(powershellShim).toContain(
          "$client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan"
        );
        const powershell = join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe"
        );
        const discovered = await execFileAsync(
          powershell,
          ["-NoLogo", "-NoProfile", "-Command", "(Get-Command compazio).Source"],
          {
            env: {
              ...process.env,
              PATH: `${bridgeSession.shimDirectory};${process.env.PATH ?? ""}`
            },
            windowsHide: true,
            timeout: 10_000
          }
        );
        expect(await realpath(discovered.stdout.trim())).toBe(
          await realpath(join(bridgeSession.shimDirectory, "compazio.ps1"))
        );
        const result = await execFileAsync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/c", "call", cli, "me"],
          {
            env: {
              ...process.env,
              COMPAZIO_BRIDGE_ENDPOINT: internals.endpoint,
              COMPAZIO_BRIDGE_TOKEN: bridgeSession.token
            },
            windowsHide: true,
            // Windows PowerShell 5.1 can take >10s to cold-start on GitHub-hosted
            // Windows images. Keep the command bounded while allowing runner startup latency.
            timeout: 30_000
          }
        );

        expect(JSON.parse(result.stdout)).toMatchObject({
          terminal: { id: terminal.id, title: "Codex local" }
        });
        expect(result.stderr).toBe("");
      } finally {
        await fixture.shutdown();
      }
    },
    45_000
  );

  windowsIt(
    "preserva mensagem multilinha e --wait no CLI PowerShell de sessão",
    async () => {
      const fixture = await createFixture();
      fixture.bridge.prepareAgentMcp = async () => undefined;
      try {
        const workspace = await fixture.workspaces.create({
          name: "PowerShell multiline CLI",
          workingDirectory: process.cwd()
        });
        const withSource = await fixture.workspaces.addTerminal(workspace.id, {
          title: "Source",
          agentConfig: { agentId: "claude-code" },
          launchConfig: testProcessLaunch()
        });
        const source = withSource.nodes.find((node) => node.type === "terminal");
        if (source?.type !== "terminal") throw new Error("source fixture missing");
        const withTarget = await fixture.workspaces.addTerminal(workspace.id, {
          title: "Target",
          agentConfig: { agentId: "codex" },
          launchConfig: testProcessLaunch()
        });
        const target = withTarget.nodes.find(
          (node) => node.type === "terminal" && node.title === "Target"
        );
        if (target?.type !== "terminal") throw new Error("target fixture missing");
        await fixture.workspaces.addEdge(workspace.id, source.id, target.id, ["send-message"]);
        const sourceSession = await fixture.workspaces.startTerminal(workspace.id, source.id);
        const targetSession = await fixture.workspaces.startTerminal(workspace.id, target.id);

        const waiting = windowsPowerShellBridgeCli(fixture.bridge, sourceSession.id, [
          "send",
          target.id,
          "FIRST_LINE\nSECOND_LINE",
          "--wait",
          "--timeout",
          "5"
        ]);
        const inbox = await waitForBridgeInbox(fixture.bridge, targetSession.id);
        expect(inbox.requests[0]?.message).toBe("FIRST_LINE\nSECOND_LINE");
        const requestId = inbox.requests[0]?.requestId;
        if (requestId === undefined) throw new Error("delivered request fixture missing");
        await windowsPowerShellBridgeCli(fixture.bridge, targetSession.id, [
          "reply",
          requestId,
          "MULTILINE_WAIT_OK"
        ]);

        const result = await waiting;
        expect(JSON.parse(result.stdout)).toMatchObject({
          status: "responded",
          timedOut: false,
          response: "MULTILINE_WAIT_OK"
        });
      } finally {
        await fixture.shutdown();
      }
    },
    20_000
  );

  windowsIt(
    "responde pelo CLI enquanto o remetente aguarda no broker",
    async () => {
      const fixture = await createFixture();
      fixture.bridge.prepareAgentMcp = async () => undefined;
      try {
        const workspace = await fixture.workspaces.create({
          name: "Concurrent CLI reply",
          workingDirectory: process.cwd()
        });
        const withSource = await fixture.workspaces.addTerminal(workspace.id, {
          title: "Source",
          agentConfig: { agentId: "claude-code" },
          launchConfig: testProcessLaunch()
        });
        const source = withSource.nodes.find((node) => node.type === "terminal");
        if (source?.type !== "terminal") throw new Error("source fixture missing");
        const withTarget = await fixture.workspaces.addTerminal(workspace.id, {
          title: "Target",
          agentConfig: { agentId: "codex" },
          launchConfig: testProcessLaunch()
        });
        const target = withTarget.nodes.find(
          (node) => node.type === "terminal" && node.title === "Target"
        );
        if (target?.type !== "terminal") throw new Error("target fixture missing");
        await fixture.workspaces.addEdge(workspace.id, source.id, target.id, ["send-message"]);
        const sourceSession = await fixture.workspaces.startTerminal(workspace.id, source.id);
        const targetSession = await fixture.workspaces.startTerminal(workspace.id, target.id);

        const waiting = bridgeCommand(fixture.bridge, sourceSession.id, [
          "send",
          target.id,
          "Reply from CLI",
          "--wait",
          "--timeout",
          "5"
        ]);
        const inbox = await waitForBridgeInbox(fixture.bridge, targetSession.id);
        const requestId = inbox.requests[0]?.requestId;
        if (requestId === undefined) throw new Error("delivered request fixture missing");
        const reply = await windowsBridgeCli(fixture.bridge, targetSession.id, [
          "reply",
          requestId,
          "CONCURRENT_REPLY_OK"
        ]);

        expect(JSON.parse(reply.stdout)).toMatchObject({
          status: "responded",
          response: "CONCURRENT_REPLY_OK"
        });
        await expect(waiting).resolves.toMatchObject({
          ok: true,
          result: { status: "responded", timedOut: false, response: "CONCURRENT_REPLY_OK" }
        });
      } finally {
        await fixture.shutdown();
      }
    },
    20_000
  );

  it("entrega no PTY visível e só conclui depois de reply autenticado", async () => {
    const fixture = await createFixture();
    // The connection contract is under test here, not provider boot flags. Both terminal nodes use
    // a deterministic pipe-backed process, which is the AGENTS.md-required fake process adapter.
    fixture.bridge.prepareAgentMcp = async () => undefined;
    const output: string[] = [];
    const unsubscribe = fixture.workspaces.subscribe((event) => {
      if (event.type === "terminal.output") output.push(event.data);
    });
    try {
      const workspace = await fixture.workspaces.create({
        name: "Messages",
        workingDirectory: process.cwd()
      });
      const sourceWorkspace = await fixture.workspaces.addTerminal(workspace.id, {
        title: "Claude",
        agentConfig: { agentId: "claude-code" },
        launchConfig: testProcessLaunch()
      });
      const source = sourceWorkspace.nodes.find(
        (node) => node.type === "terminal" && node.title === "Claude"
      );
      if (source?.type !== "terminal") throw new Error("source fixture missing");
      const targetWorkspace = await fixture.workspaces.addTerminal(workspace.id, {
        title: "Codex",
        agentConfig: { agentId: "codex" },
        launchConfig: testProcessLaunch()
      });
      const target = targetWorkspace.nodes.find(
        (node) => node.type === "terminal" && node.title === "Codex"
      );
      if (target?.type !== "terminal") throw new Error("target fixture missing");
      await fixture.workspaces.addEdge(workspace.id, source.id, target.id, ["send-message"]);
      const sourceSession = await fixture.workspaces.startTerminal(workspace.id, source.id);
      const targetSession = await fixture.workspaces.startTerminal(workspace.id, target.id);

      const sent = await bridgeCommand(fixture.bridge, sourceSession.id, [
        "send",
        "Codex",
        "Revise",
        "o",
        "README"
      ]);
      expect(sent).toMatchObject({ ok: true, result: { status: "delivered" } });
      const requestId = requireResultString(sent, "requestId");
      await expect(
        waitFor(() => output.join("").includes(`Compazio request ${requestId}`))
      ).resolves.toBeUndefined();
      expect(output.join("")).toContain(`compazio reply ${requestId}`);

      await expect(
        bridgeCommand(fixture.bridge, sourceSession.id, ["reply", requestId, "indevida"])
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "REPLY_PERMISSION_DENIED" }
      });
      await expect(
        bridgeCommand(fixture.bridge, targetSession.id, [
          "reply",
          requestId,
          "1.",
          "Simplifique",
          "a",
          "introdução"
        ])
      ).resolves.toMatchObject({ ok: true, result: { status: "responded" } });
      await expect(
        bridgeCommand(fixture.bridge, sourceSession.id, ["wait", requestId, "--timeout", "1"])
      ).resolves.toMatchObject({
        ok: true,
        result: { timedOut: false, response: "1. Simplifique a introdução" }
      });
      await expect(
        bridgeCommand(fixture.bridge, targetSession.id, ["inbox"])
      ).resolves.toMatchObject({
        ok: true,
        result: { requests: [] }
      });
    } finally {
      unsubscribe();
      await fixture.shutdown();
    }
  }, 20_000);

  it("falha de forma explícita para destino parado, ausente e ambíguo", async () => {
    const fixture = await createFixture();
    fixture.bridge.prepareAgentMcp = async () => undefined;
    try {
      const workspace = await fixture.workspaces.create({
        name: "Resolution",
        workingDirectory: process.cwd()
      });
      const withSource = await fixture.workspaces.addTerminal(workspace.id, {
        title: "Origem",
        agentConfig: { agentId: "claude-code" },
        launchConfig: testProcessLaunch()
      });
      const source = withSource.nodes.find((node) => node.title === "Origem");
      if (source?.type !== "terminal") throw new Error("source fixture missing");
      const withFirst = await fixture.workspaces.addTerminal(workspace.id, {
        title: "Revisor",
        agentConfig: { agentId: "codex" },
        launchConfig: testProcessLaunch()
      });
      const first = withFirst.nodes.find((node) => node.title === "Revisor");
      if (first?.type !== "terminal") throw new Error("first target fixture missing");
      await fixture.workspaces.addEdge(workspace.id, source.id, first.id, ["send-message"]);
      const sourceSession = await fixture.workspaces.startTerminal(workspace.id, source.id);

      await expect(
        bridgeCommand(fixture.bridge, sourceSession.id, ["send", "Revisor", "Revise"])
      ).resolves.toMatchObject({ ok: false, error: { code: "TARGET_NOT_RUNNING" } });
      await expect(
        bridgeCommand(fixture.bridge, sourceSession.id, ["send", "Ausente", "Revise"])
      ).resolves.toMatchObject({ ok: false, error: { code: "CONNECTED_TARGET_NOT_FOUND" } });

      await fixture.workspaces.startTerminal(workspace.id, first.id);
      const withSecond = await fixture.workspaces.addTerminal(workspace.id, {
        title: "Revisor",
        agentConfig: { agentId: "codex" },
        launchConfig: testProcessLaunch()
      });
      const second = withSecond.nodes.find(
        (node) => node.type === "terminal" && node.title === "Revisor" && node.id !== first.id
      );
      if (second?.type !== "terminal") throw new Error("second target fixture missing");
      await fixture.workspaces.addEdge(workspace.id, source.id, second.id, ["send-message"]);
      await fixture.workspaces.startTerminal(workspace.id, second.id);
      await expect(
        bridgeCommand(fixture.bridge, sourceSession.id, ["send", "Revisor", "Revise"])
      ).resolves.toMatchObject({ ok: false, error: { code: "CONNECTED_TARGET_AMBIGUOUS" } });
    } finally {
      await fixture.shutdown();
    }
  }, 20_000);

  it("resolve notas conectadas por título sem ampliar as capacidades", async () => {
    const fixture = await createFixture();
    fixture.bridge.prepareAgentMcp = async () => undefined;
    try {
      const workspace = await fixture.workspaces.create({
        name: "Notes",
        workingDirectory: process.cwd()
      });
      const withSource = await fixture.workspaces.addTerminal(workspace.id, {
        title: "Claude",
        agentConfig: { agentId: "claude-code" },
        launchConfig: testProcessLaunch()
      });
      const source = withSource.nodes.find((node) => node.type === "terminal");
      if (source?.type !== "terminal") throw new Error("source fixture missing");
      const withNote = await fixture.workspaces.addNote(workspace.id, {
        title: "Plano técnico",
        content: "# Plano"
      });
      const note = withNote.nodes.find((node) => node.type === "note");
      if (note?.type !== "note") throw new Error("note fixture missing");
      await fixture.workspaces.addEdge(workspace.id, source.id, note.id, ["read-note"]);
      const session = await fixture.workspaces.startTerminal(workspace.id, source.id);

      await expect(
        bridgeCommand(fixture.bridge, session.id, ["note", "read", "Plano técnico"])
      ).resolves.toMatchObject({ ok: true, result: { note: { content: "# Plano" } } });
      await expect(
        bridgeCommand(fixture.bridge, session.id, ["note", "append", "Plano técnico", "extra"])
      ).resolves.toMatchObject({ ok: false, error: { code: "CONNECTED_NOTE_NOT_FOUND" } });
    } finally {
      await fixture.shutdown();
    }
  }, 20_000);

  it("coordena somente terminais visíveis que criou e preserva os cartões ao fechar", async () => {
    const fixture = await createFixture({ orchestratorMode: true });
    fixture.bridge.prepareAgentMcp = async () => undefined;
    try {
      const reviewer = await fixture.agents.createRole({
        name: "Revisor",
        instructions: "Revise o trabalho e responda com evidências."
      });
      const tester = await fixture.agents.createRole({
        name: "Testador",
        instructions: "Valide o trabalho e responda com evidências."
      });
      const preset = await fixture.agents.createPreset({
        name: "Fake coding agent",
        agentId: "codex",
        executable: process.execPath,
        args: [
          "-e",
          "process.stdin.on('data', chunk => process.stdout.write(chunk)); setInterval(() => {}, 1000);"
        ],
        env: {},
        processMode: "pipe"
      });
      const workspace = await fixture.workspaces.create({
        name: "Visible coordination",
        workingDirectory: process.cwd()
      });
      const configured = await fixture.workspaces.addTerminal(workspace.id, {
        title: "Coordenador",
        agentConfig: { agentId: "claude-code" },
        launchConfig: testProcessLaunch(),
        isCompazio: true
      });
      const coordinator = configured.nodes.find(
        (node) => node.type === "terminal" && node.title === "Coordenador"
      );
      if (coordinator?.type !== "terminal") throw new Error("coordinator fixture missing");
      const coordinatorSession = await fixture.workspaces.startTerminal(
        workspace.id,
        coordinator.id
      );
      const internals = fixture.bridge as unknown as {
        readonly sessionsById: ReadonlyMap<string, { readonly protocol: string }>;
      };
      expect(internals.sessionsById.get(coordinatorSession.id)?.protocol).toContain(
        "compazio spawn"
      );
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["me"])
      ).resolves.toMatchObject({
        ok: true,
        result: {
          permissions: expect.arrayContaining(["spawn", "connect", "close", "note:create"]),
          limits: { maximumOwnedAgents: 6, maximumRunningOwnedAgents: 4 }
        }
      });
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["note", "create", "--help"])
      ).resolves.toMatchObject({ ok: true, result: { commands: expect.any(Array) } });
      expect(
        (await fixture.workspaces.snapshot(workspace.id)).nodes.filter(
          (node) => node.type === "note"
        )
      ).toHaveLength(0);
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, [
          "note",
          "create",
          "--title",
          "Relatório",
          "--content",
          "Coordenação visível"
        ])
      ).resolves.toMatchObject({
        ok: true,
        result: {
          note: { title: "Relatório", content: "Coordenação visível" },
          edge: { sourceNodeId: coordinator.id }
        }
      });

      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, [
          "spawn",
          "--agent",
          "codex",
          "--preset",
          preset.id,
          "--role",
          reviewer.id,
          "--title",
          "Revisor"
        ])
      ).resolves.toMatchObject({
        ok: true,
        result: {
          terminal: {
            title: "Revisor",
            roleId: reviewer.id,
            orchestratorOwnerNodeId: coordinator.id,
            session: { state: "running" }
          }
        }
      });
      let snapshot = await fixture.workspaces.snapshot(workspace.id);
      const owned = snapshot.nodes.find(
        (node) => node.type === "terminal" && node.orchestratorOwnerNodeId === coordinator.id
      );
      if (owned?.type !== "terminal") throw new Error("owned terminal fixture missing");
      expect(snapshot.edges).toContainEqual(
        expect.objectContaining({
          sourceNodeId: coordinator.id,
          targetNodeId: owned.id,
          capabilities: ["send-message", "share-context"]
        })
      );

      const withNote = await fixture.workspaces.addNote(workspace.id, {
        title: "Briefing",
        content: "# Escopo"
      });
      const note = withNote.nodes.find((node) => node.type === "note" && node.title === "Briefing");
      if (note?.type !== "note") throw new Error("note fixture missing");
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["connect", "Revisor", "Briefing"])
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "CONNECTION_PERMISSION_DENIED" }
      });
      await fixture.workspaces.addEdge(workspace.id, coordinator.id, note.id, [
        "read-note",
        "write-note",
        "share-context"
      ]);
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["connect", "Revisor", "Briefing"])
      ).resolves.toMatchObject({ ok: true, result: { created: true } });
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["disconnect", "Revisor", "Briefing"])
      ).resolves.toMatchObject({ ok: true, result: { disconnected: true } });
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["connect", "Revisor", "Briefing"])
      ).resolves.toMatchObject({ ok: true, result: { created: true } });

      const withPortal = await fixture.workspaces.addPortal(workspace.id, {
        title: "Aplicação",
        url: "http://127.0.0.1:41800/"
      });
      const portal = withPortal.nodes.find(
        (node) => node.type === "portal" && node.title === "Aplicação"
      );
      if (portal?.type !== "portal") throw new Error("portal fixture missing");
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["connect", "Revisor", "Aplicação"])
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "CONNECTION_PERMISSION_DENIED" }
      });
      await fixture.workspaces.addEdge(workspace.id, coordinator.id, portal.id, [
        "portal-read",
        "portal-control",
        "portal-screenshot",
        "share-context"
      ]);
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["connect", "Revisor", "Aplicação"])
      ).resolves.toMatchObject({
        ok: true,
        result: {
          created: true,
          edge: {
            sourceNodeId: owned.id,
            targetNodeId: portal.id,
            capabilities: ["portal-read", "portal-control", "portal-screenshot", "share-context"]
          }
        }
      });
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["disconnect", "Revisor", "Aplicação"])
      ).resolves.toMatchObject({ ok: true, result: { disconnected: true } });
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["assign-role", "Revisor", tester.id])
      ).resolves.toMatchObject({
        ok: true,
        result: { terminalNodeId: owned.id, roleId: tester.id }
      });

      for (const title of ["Agente 2", "Agente 3", "Agente 4"]) {
        await expect(
          bridgeCommand(fixture.bridge, coordinatorSession.id, [
            "spawn",
            "--agent",
            "codex",
            "--preset",
            preset.id,
            "--title",
            title
          ])
        ).resolves.toMatchObject({ ok: true });
      }
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, [
          "spawn",
          "--agent",
          "codex",
          "--preset",
          preset.id,
          "--title",
          "Agente 5"
        ])
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "CONCURRENT_AGENT_LIMIT_REACHED" }
      });

      const withManual = await fixture.workspaces.addTerminal(workspace.id, {
        title: "Manual",
        agentConfig: { agentId: "codex" },
        launchConfig: testProcessLaunch()
      });
      const manual = withManual.nodes.find(
        (node) => node.type === "terminal" && node.title === "Manual"
      );
      if (manual?.type !== "terminal") throw new Error("manual terminal fixture missing");
      await fixture.workspaces.addEdge(workspace.id, coordinator.id, manual.id, ["send-message"]);
      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["close", "Manual"])
      ).resolves.toMatchObject({ ok: false, error: { code: "OWNED_TERMINAL_NOT_FOUND" } });

      await expect(
        bridgeCommand(fixture.bridge, coordinatorSession.id, ["close", "Revisor"])
      ).resolves.toMatchObject({
        ok: true,
        result: { terminalNodeId: owned.id, closed: true, retainedOnCanvas: true }
      });
      snapshot = await fixture.workspaces.snapshot(workspace.id);
      const retained = snapshot.nodes.find((node) => node.id === owned.id);
      expect(retained).toMatchObject({ id: owned.id, type: "terminal" });
      expect(
        retained?.type === "terminal" ? retained.orchestratorOwnerNodeId : "not-a-terminal"
      ).toBeUndefined();
      expect(fixture.workspaces.sessionForNode(workspace.id, owned.id)).toBeNull();
      expect(
        snapshot.edges.some(
          (edge) => edge.sourceNodeId === owned.id || edge.targetNodeId === owned.id
        )
      ).toBe(false);
    } finally {
      await fixture.shutdown();
    }
  }, 30_000);

  it("não concede comandos de coordenação a um terminal normal", async () => {
    const fixture = await createFixture({ orchestratorMode: true });
    fixture.bridge.prepareAgentMcp = async () => undefined;
    try {
      const workspace = await fixture.workspaces.create({
        name: "No escalation",
        workingDirectory: process.cwd()
      });
      const configured = await fixture.workspaces.addTerminal(workspace.id, {
        title: "Agente normal",
        agentConfig: { agentId: "claude-code" },
        launchConfig: testProcessLaunch()
      });
      const terminal = configured.nodes.find((node) => node.type === "terminal");
      if (terminal?.type !== "terminal") throw new Error("terminal fixture missing");
      const session = await fixture.workspaces.startTerminal(workspace.id, terminal.id);
      await expect(
        bridgeCommand(fixture.bridge, session.id, ["spawn", "--agent", "codex"])
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "ORCHESTRATOR_MODE_DISABLED" }
      });
    } finally {
      await fixture.shutdown();
    }
  }, 20_000);
});

async function createFixture(options: { readonly orchestratorMode?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "compazio-v2-bridge-"));
  roots.push(root);
  const repository = new V2WorkspaceRepository({ rootDirectory: root });
  const supervisor = new V2ProcessSupervisor(
    new TransportProcessFactory({
      pty: new PipeProcessFactory(),
      pipe: new PipeProcessFactory()
    }),
    { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 100 }
  );
  const agents = new AgentRuntime({
    store: repository,
    roleInjection: new RoleInjectionService(join(root, "role-sessions"))
  });
  const workspaces = new V2WorkspaceService({
    repository,
    supervisor,
    agents,
    entitlement: isolatedTestEntitlement(root)
  });
  const bridge = new V2OrchestratorBridge({
    workspaces,
    agents,
    storageDirectory: root,
    nodeExecutable: process.execPath,
    orchestratorMode: options.orchestratorMode
  });
  await bridge.start();
  workspaces.setOrchestratorBridge(bridge);
  return {
    root,
    agents,
    workspaces,
    bridge,
    async shutdown(): Promise<void> {
      await workspaces.shutdown();
      await bridge.shutdown();
    }
  };
}

function testProcessLaunch() {
  return {
    command: process.execPath,
    args: [
      "-e",
      "process.stdin.on('data', chunk => process.stdout.write(chunk)); setInterval(() => {}, 1000);"
    ],
    env: {},
    processMode: "pipe" as const
  };
}

async function bridgeCommand(
  bridge: V2OrchestratorBridge,
  sessionId: string,
  args: readonly string[]
): Promise<{
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string };
}> {
  const internals = bridge as unknown as {
    readonly endpoint: string;
    readonly sessionsById: ReadonlyMap<string, { readonly token: string }>;
  };
  const token = internals.sessionsById.get(sessionId)?.token;
  if (token === undefined) throw new Error("bridge session fixture missing");
  const response = await fetch(internals.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ args })
  });
  return (await response.json()) as {
    readonly ok: boolean;
    readonly result?: unknown;
    readonly error?: { readonly code: string };
  };
}

async function windowsBridgeCli(
  bridge: V2OrchestratorBridge,
  sessionId: string,
  args: readonly string[]
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const internals = bridge as unknown as {
    readonly endpoint: string;
    readonly sessionsById: ReadonlyMap<
      string,
      { readonly token: string; readonly shimDirectory: string }
    >;
  };
  const session = internals.sessionsById.get(sessionId);
  if (session === undefined) throw new Error("bridge session fixture missing");
  return execFileAsync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", "call", join(session.shimDirectory, "compazio.cmd"), ...args],
    {
      env: {
        ...process.env,
        COMPAZIO_BRIDGE_ENDPOINT: internals.endpoint,
        COMPAZIO_BRIDGE_TOKEN: session.token
      },
      windowsHide: true,
      timeout: 10_000
    }
  );
}

async function windowsPowerShellBridgeCli(
  bridge: V2OrchestratorBridge,
  sessionId: string,
  args: readonly string[]
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const internals = bridge as unknown as {
    readonly endpoint: string;
    readonly sessionsById: ReadonlyMap<
      string,
      { readonly token: string; readonly shimDirectory: string }
    >;
  };
  const session = internals.sessionsById.get(sessionId);
  if (session === undefined) throw new Error("bridge session fixture missing");
  return execFileAsync(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(session.shimDirectory, "compazio.ps1"),
      ...args
    ],
    {
      env: {
        ...process.env,
        COMPAZIO_BRIDGE_ENDPOINT: internals.endpoint,
        COMPAZIO_BRIDGE_TOKEN: session.token
      },
      windowsHide: true,
      timeout: 10_000
    }
  );
}

async function waitForBridgeInbox(
  bridge: V2OrchestratorBridge,
  sessionId: string
): Promise<{
  readonly requests: readonly { readonly requestId: string; readonly message: string }[];
}> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const response = await bridgeCommand(bridge, sessionId, ["inbox"]);
    const result = response.result as
      | {
          readonly requests?: readonly {
            readonly requestId: string;
            readonly message: string;
          }[];
        }
      | undefined;
    if ((result?.requests.length ?? 0) > 0) {
      return { requests: result?.requests ?? [] };
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for bridge inbox");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function requireResultString(response: { readonly result?: unknown }, key: string): string {
  if (
    typeof response.result !== "object" ||
    response.result === null ||
    typeof (response.result as Record<string, unknown>)[key] !== "string"
  ) {
    throw new Error(`missing result.${key}`);
  }
  return (response.result as Record<string, string>)[key] ?? "";
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for terminal output");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
