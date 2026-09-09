import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  addPortalNode,
  addFilePreviewNode,
  addNoteNode,
  addTerminalNode,
  addVisualEdge,
  createWorkspace,
  removeEdge,
  updateNode,
  type EdgeCapability,
  type Workspace
} from "@forgedeck/compazio-v2-domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompazioMcpGateway } from "./compazio-mcp-gateway";
import type { PortalRuntimeManager } from "./portal-runtime-manager";
import type { V2WorkspaceService } from "./workspace-service";
import type { TeamCoordinator } from "./team-coordinator";
import { startPortalFixture, type PortalFixture } from "./e2e/portal-fixture";

let fixture: PortalFixture | null = null;
let gateway: CompazioMcpGateway | null = null;
let client: Client | null = null;

afterEach(async () => {
  await client?.close();
  await gateway?.shutdown();
  await fixture?.close();
  client = null;
  gateway = null;
  fixture = null;
});

describe("Compazio MCP gateway", () => {
  it("delivers connected images and extracted PDF text through provider-neutral MCP content", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-connected-media-"));
    try {
      await writeFile(
        join(root, "reference.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64"
        )
      );
      await writeFile(join(root, "brief.pdf"), simplePdf("COMPAZIO_MEDIA_OK"));
      let counter = 0;
      const dependencies = {
        createId: () => `media-${++counter}`,
        now: () => `2026-08-14T22:00:0${counter}.000Z`
      };
      let workspace = createWorkspace(
        { name: "Connected media", workingDirectory: root },
        dependencies
      );
      workspace = addTerminalNode(workspace, { title: "Claude" }, dependencies);
      workspace = addFilePreviewNode(
        workspace,
        { title: "Reference", filePath: "reference.png", previewKind: "image" },
        dependencies
      );
      workspace = addFilePreviewNode(
        workspace,
        { title: "Brief", filePath: "brief.pdf", previewKind: "pdf" },
        dependencies
      );
      const terminal = workspace.nodes.find((node) => node.type === "terminal");
      const image = workspace.nodes.find(
        (node) => node.type === "file-preview" && node.previewKind === "image"
      );
      const pdf = workspace.nodes.find(
        (node) => node.type === "file-preview" && node.previewKind === "pdf"
      );
      if (
        terminal?.type !== "terminal" ||
        image?.type !== "file-preview" ||
        pdf?.type !== "file-preview"
      )
        throw new Error("media fixture missing");
      workspace = addVisualEdge(workspace, terminal.id, image.id, dependencies, ["share-context"]);
      workspace = addVisualEdge(workspace, terminal.id, pdf.id, dependencies, ["share-context"]);
      const workspaceService = {
        snapshot: async () => workspace
      } as unknown as V2WorkspaceService;
      gateway = new CompazioMcpGateway(workspaceService, {} as PortalRuntimeManager);
      await gateway.start();
      const bootstrap = gateway.createAgentSession({
        workspaceId: workspace.id,
        terminalId: terminal.id,
        capabilities: []
      });
      client = await connect(bootstrap.endpoint, bootstrap.token);

      await expect(
        client.callTool({ name: "context_read", arguments: { nodeId: image.id } })
      ).resolves.toMatchObject({
        content: expect.arrayContaining([
          expect.objectContaining({ type: "image", mimeType: "image/png" })
        ]),
        structuredContent: { ok: true, data: { type: "image", title: "Reference" } }
      });
      await expect(
        client.callTool({ name: "context_read", arguments: { nodeId: pdf.id } })
      ).resolves.toMatchObject({
        structuredContent: {
          ok: true,
          data: {
            previewKind: "pdf",
            pdf: expect.objectContaining({
              pages: 1,
              hasExtractableText: true,
              text: expect.stringContaining("COMPAZIO_MEDIA_OK")
            })
          }
        }
      });
    } finally {
      await client?.close();
      await gateway?.shutdown();
      client = null;
      gateway = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("owns a managed workspace server and closes it with the gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-managed-portal-"));
    try {
      await writeFile(join(root, "index.html"), "<h1>Managed Bella Pele</h1>", "utf8");
      await writeFile(
        join(root, "reference.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
        "utf8"
      );
      let counter = 0;
      const dependencies = {
        createId: () => `managed-${++counter}`,
        now: () => "2026-08-11T20:00:00.000Z"
      };
      let workspace = createWorkspace(
        { name: "managed portal", workingDirectory: root },
        dependencies
      );
      workspace = addTerminalNode(workspace, { title: "COMPAZIO", isCompazio: true }, dependencies);
      const terminal = workspace.nodes.find((node) => node.type === "terminal");
      if (terminal?.type !== "terminal") throw new Error("managed terminal missing");
      const workspaceService = {
        list: async () => ({ workspaces: [], lastOpenedWorkspaceId: workspace.id }),
        snapshot: async () => workspace,
        addPortal: async (_workspaceId: string, input: { title?: string; url?: string }) => {
          workspace = addPortalNode(workspace, input, dependencies);
          return workspace;
        },
        addFilePreview: async (
          _workspaceId: string,
          input: Parameters<typeof addFilePreviewNode>[1]
        ) => {
          workspace = addFilePreviewNode(workspace, input, dependencies);
          return workspace;
        },
        addEdge: async (
          _workspaceId: string,
          sourceNodeId: string,
          targetNodeId: string,
          capabilities: readonly EdgeCapability[]
        ) => {
          workspace = addVisualEdge(
            workspace,
            sourceNodeId,
            targetNodeId,
            dependencies,
            capabilities
          );
          return workspace;
        },
        updatePortal: async (
          _workspaceId: string,
          nodeId: string,
          patch: Record<string, unknown>
        ) => {
          workspace = updateNode(workspace, nodeId, patch, dependencies);
          return workspace;
        }
      } as unknown as V2WorkspaceService;
      gateway = new CompazioMcpGateway(workspaceService, {} as PortalRuntimeManager);
      await gateway.start();
      const bootstrap = gateway.createAgentSession({
        workspaceId: workspace.id,
        terminalId: terminal.id,
        capabilities: []
      });
      client = await connect(bootstrap.endpoint, bootstrap.token);
      await expect(
        client.callTool({
          name: "file_preview_create",
          arguments: { filePath: "reference.svg", title: "Reference image" }
        })
      ).resolves.toMatchObject({
        structuredContent: {
          ok: true,
          data: { filePreview: { filePath: "reference.svg" }, connected: true }
        }
      });
      expect(workspace.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "file-preview", previewKind: "image" })
        ])
      );
      const result = await client.callTool({
        name: "portal_create",
        arguments: { title: "Managed", serveWorkspace: true }
      });
      expect(result.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining('"managedServer"') })
      ]);
      const managedUrl = (
        result.structuredContent as { data?: { managedServer?: { url?: string } } }
      ).data?.managedServer?.url;
      expect(managedUrl).toMatch(/^http:\/\/localhost:418\d{2}\/$/);
      await expect(fetch(managedUrl ?? "").then((response) => response.text())).resolves.toContain(
        "Managed Bella Pele"
      );
      const portal = workspace.nodes.find((node) => node.type === "portal");
      if (portal?.type !== "portal" || managedUrl === undefined)
        throw new Error("managed portal missing");
      workspace = updateNode(workspace, portal.id, { url: `${managedUrl}#faq` }, dependencies);
      await client.close();
      client = null;
      await gateway.shutdown();
      gateway = null;
      await expect(fetch(managedUrl ?? "")).rejects.toThrow();

      gateway = new CompazioMcpGateway(workspaceService, {} as PortalRuntimeManager);
      await gateway.start();
      await gateway.restoreManagedWorkspaceServer();
      await expect(fetch(managedUrl ?? "").then((response) => response.text())).resolves.toContain(
        "Managed Bella Pele"
      );
      await gateway.shutdown();
      gateway = null;
      await expect(fetch(managedUrl ?? "")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("negotiates MCP over loopback and lists only connection-authorized portals", async () => {
    const scene = await createScene(true);
    const requests: unknown[] = [];
    const unsubscribe = gateway?.subscribeHttpRequests((request) => requests.push(request));
    const bootstrap = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: ["portal-read", "portal-control", "portal-screenshot"]
    });
    if (bootstrap === undefined) throw new Error("MCP bootstrap missing");

    client = await connect(bootstrap.endpoint, bootstrap.token);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["portal_list", "portal_navigate", "portal_screenshot"])
    );
    const response = await client.callTool({ name: "portal_list", arguments: {} });
    const structured = response.structuredContent as {
      readonly data?: { readonly portals?: readonly { readonly id: string }[] };
    };
    expect(structured.data?.portals?.map((portal) => portal.id)).toEqual([scene.portalId]);
    expect(gateway?.diagnostics()).toMatchObject({
      listening: true,
      activeSessionCount: 1,
      transportCount: 1
    });
    expect(requests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        rpcMethod: "initialize",
        protocolVersion: "2025-11-25",
        outcome: "accepted"
      })
    );
    expect(requests).toContainEqual(
      expect.objectContaining({
        rpcMethod: "tools/list",
        advertisedTools: expect.arrayContaining([
          "portal_list",
          "portal_navigate",
          "portal_screenshot"
        ]),
        outcome: "accepted"
      })
    );
    unsubscribe?.();
  });

  it("rejects absent and invalid Bearer tokens before MCP initialization", async () => {
    const scene = await createScene(true);
    const bootstrap = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: ["portal-read", "portal-control", "portal-screenshot"]
    });
    if (bootstrap === undefined) throw new Error("MCP bootstrap missing");
    await expect(
      fetch(bootstrap.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      fetch(bootstrap.endpoint, {
        method: "POST",
        headers: { authorization: "Bearer invalid", "content-type": "application/json" },
        body: "{}"
      })
    ).resolves.toMatchObject({ status: 401 });
  });

  it("rejects a token from session A when it is used against session B", async () => {
    const scene = await createScene(true);
    const first = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: ["portal-read"]
    });
    const second = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: ["portal-read"]
    });
    if (first === undefined || second === undefined) throw new Error("MCP bootstrap missing");
    const secondClient = await connect(second.endpoint, second.token);
    try {
      const transports = (
        gateway as unknown as {
          readonly transports: ReadonlyMap<string, { readonly compazioSessionId: string }>;
        }
      ).transports;
      const transportId = [...transports.entries()].find(
        ([, transport]) => transport.compazioSessionId === second.sessionId
      )?.[0];
      if (transportId === undefined) throw new Error("second MCP transport missing");
      await expect(
        fetch(first.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${first.token}`,
            "mcp-session-id": transportId,
            "content-type": "application/json"
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
        })
      ).resolves.toMatchObject({ status: 403 });
    } finally {
      await secondClient.close();
    }
  });

  it("rejects a cross-workspace context read even when the agent knows the foreign node id", async () => {
    let counter = 0;
    const dependencies = {
      createId: () => `cross-workspace-${++counter}`,
      now: () => `2026-08-07T12:00:0${counter}.000Z`
    };
    let workspaceA = createWorkspace({ name: "A", workingDirectory: "C:/tmp/a" }, dependencies);
    workspaceA = addTerminalNode(workspaceA, { title: "Agent A" }, dependencies);
    let workspaceB = createWorkspace({ name: "B", workingDirectory: "C:/tmp/b" }, dependencies);
    workspaceB = addNoteNode(workspaceB, { title: "Artifact B", content: "private" }, dependencies);
    const terminal = workspaceA.nodes.find((node) => node.type === "terminal");
    const foreign = workspaceB.nodes.find((node) => node.type === "note");
    if (terminal?.type !== "terminal" || foreign?.type !== "note")
      throw new Error("fixture missing");
    gateway = new CompazioMcpGateway(
      {
        snapshot: async (workspaceId: string) => {
          if (workspaceId === workspaceA.id) return workspaceA;
          if (workspaceId === workspaceB.id) return workspaceB;
          throw new Error("workspace not found");
        }
      } as unknown as V2WorkspaceService,
      {} as PortalRuntimeManager
    );
    await gateway.start();
    const bootstrap = gateway.createAgentSession({
      workspaceId: workspaceA.id,
      terminalId: terminal.id,
      capabilities: []
    });
    client = await connect(bootstrap.endpoint, bootstrap.token);
    await expect(
      client.callTool({ name: "context_read", arguments: { nodeId: foreign.id } })
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "PORTAL_NOT_CONNECTED" } }
    });
  });

  it("rejects Portal capability calls when the terminal was never connected", async () => {
    const scene = await createScene(false);
    const bootstrap = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: ["portal-read"]
    });
    if (bootstrap === undefined) throw new Error("MCP bootstrap missing");
    client = await connect(bootstrap.endpoint, bootstrap.token);
    await expect(client.callTool({ name: "portal_list", arguments: {} })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "PORTAL_NOT_CONNECTED" } }
    });
  });

  it("does not expose workspace creation to an MCP agent or a COMPAZIO session", async () => {
    const scene = await createScene(true);
    for (const capabilities of [[], ["team-recruit"]] as const) {
      const bootstrap = gateway?.createAgentSession({
        workspaceId: scene.workspace.id,
        terminalId: scene.terminalId,
        capabilities
      });
      if (bootstrap === undefined) throw new Error("MCP bootstrap missing");
      const probe = await connect(bootstrap.endpoint, bootstrap.token);
      try {
        expect((await probe.listTools()).tools.map((tool) => tool.name)).not.toContain(
          "workspace_create"
        );
        await expect(
          probe.callTool({ name: "workspace_create", arguments: { name: "forbidden" } })
        ).resolves.toMatchObject({ isError: true });
      } finally {
        await probe.close();
      }
    }
  });

  it("registers strict Portal tools that reuse the runtime services", async () => {
    const portals = {
      ensure: vi.fn(async () => undefined),
      get: vi.fn(() => snapshot()),
      navigate: vi.fn(async () => snapshot()),
      command: vi.fn(async () => snapshot()),
      automation: vi.fn(async (_workspaceId, _portalId, action) => ({ action })),
      setViewport: vi.fn(async (_workspaceId, _portalId, viewport) => viewport),
      consoleMessages: vi.fn(() => ({ entries: [], nextCursor: null })),
      screenshot: vi.fn(async () => ({
        id: "shot-1",
        bytes: 128,
        width: 16,
        height: 16,
        expiresAt: "2026-07-29T12:10:00.000Z"
      })),
      destroy: vi.fn(async () => undefined)
    } as unknown as PortalRuntimeManager;
    const scene = await createScene(true, portals, [
      "portal-control",
      "portal-screenshot",
      "portal-close"
    ]);
    const bootstrap = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: ["portal-read", "portal-control", "portal-screenshot", "portal-close"]
    });
    if (bootstrap === undefined) throw new Error("MCP bootstrap missing");
    client = await connect(bootstrap.endpoint, bootstrap.token);

    await expect(
      client.callTool({
        name: "portal_navigate",
        arguments: { portalId: scene.portalId, extra: true }
      })
    ).resolves.toMatchObject({ isError: true });
    for (const [name, arguments_] of [
      ["portal_get", { portalId: scene.portalId }],
      ["portal_dom", { portalId: scene.portalId, maxNodes: 20 }],
      ["portal_accessibility", { portalId: scene.portalId, role: "button" }],
      ["portal_console", { portalId: scene.portalId, limit: 10 }],
      ["portal_viewport", { portalId: scene.portalId }],
      ["portal_navigate", { portalId: scene.portalId, url: "http://127.0.0.1:4100/" }],
      ["portal_back", { portalId: scene.portalId }],
      ["portal_reload", { portalId: scene.portalId }],
      ["portal_stop", { portalId: scene.portalId }],
      ["portal_focus", { portalId: scene.portalId }],
      ["portal_click", { portalId: scene.portalId, target: { role: "button", name: "Enviar" } }],
      [
        "portal_type",
        { portalId: scene.portalId, target: { label: "Nome" }, text: "Compazio", clear: true }
      ],
      ["portal_press", { portalId: scene.portalId, key: "Enter" }],
      ["portal_scroll", { portalId: scene.portalId, direction: "down", amount: 120 }],
      ["portal_screenshot", { portalId: scene.portalId }],
      ["portal_close", { portalId: scene.portalId }]
    ] as const)
      await expect(client.callTool({ name, arguments: arguments_ })).resolves.toMatchObject({
        structuredContent: { ok: true }
      });
    await expect(
      client.callTool({
        name: "portal_viewport",
        arguments: { portalId: scene.portalId, width: 390, height: 844 }
      })
    ).resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(
      client.callTool({
        name: "portal_viewport",
        arguments: { portalId: scene.portalId, width: 390 }
      })
    ).resolves.toMatchObject({ isError: true });
    expect(
      (portals as unknown as { automation: ReturnType<typeof vi.fn> }).automation
    ).toHaveBeenCalled();
    expect(
      (portals as unknown as { screenshot: ReturnType<typeof vi.fn> }).screenshot
    ).toHaveBeenCalledOnce();
    expect(
      (portals as unknown as { setViewport: ReturnType<typeof vi.fn> }).setViewport
    ).toHaveBeenCalledWith(
      scene.workspace.id,
      scene.portalId,
      { width: 390, height: 844 },
      expect.any(Object)
    );
    expect(
      (portals as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy
    ).toHaveBeenCalledOnce();
  });

  it("rejects an invalid origin and transport while deriving Portal access from the live graph", async () => {
    const scene = await createScene(true);
    const bootstrap = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: ["portal-read", "portal-control", "portal-screenshot"]
    });
    if (bootstrap === undefined) throw new Error("MCP bootstrap missing");
    await expect(
      fetch(bootstrap.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bootstrap.token}`,
          origin: "http://untrusted.example",
          "content-type": "application/json"
        },
        body: "{}"
      })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      fetch(bootstrap.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bootstrap.token}`,
          "mcp-session-id": "unknown",
          "content-type": "application/json"
        },
        body: "{}"
      })
    ).resolves.toMatchObject({ status: 404 });
    const denied = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: []
    });
    if (denied === undefined) throw new Error("Denied MCP bootstrap missing");
    client = await connect(denied.endpoint, denied.token);
    await expect(client.callTool({ name: "portal_list", arguments: {} })).resolves.toMatchObject({
      structuredContent: { ok: true, data: { portals: [{ id: scene.portalId }] } }
    });
  });

  it("rechecks portal-control and revokes an already initialized MCP session", async () => {
    const scene = await createScene(true);
    const bootstrap = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: ["portal-read", "portal-control", "portal-screenshot"]
    });
    if (bootstrap === undefined) throw new Error("MCP bootstrap missing");
    client = await connect(bootstrap.endpoint, bootstrap.token);
    await expect(client.callTool({ name: "portal_list", arguments: {} })).resolves.toMatchObject({
      structuredContent: { ok: true }
    });
    scene.revokeEdge();
    await expect(client.callTool({ name: "portal_list", arguments: {} })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "PORTAL_NOT_CONNECTED" } }
    });
    await gateway?.revokeAgentSession(bootstrap.sessionId);
    await expect(client.callTool({ name: "portal_list", arguments: {} })).rejects.toThrow();
  });

  it("expires sessions and leaves shutdown idempotent", async () => {
    const scene = await createScene(true);
    const bootstrap = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: ["portal-read", "portal-control", "portal-screenshot"],
      lifetimeMs: 1_000
    });
    if (bootstrap === undefined) throw new Error("MCP bootstrap missing");
    client = await connect(bootstrap.endpoint, bootstrap.token);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await expect(client.callTool({ name: "portal_list", arguments: {} })).rejects.toThrow();
    await expect(
      fetch(bootstrap.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${bootstrap.token}`, "content-type": "application/json" },
        body: "{}"
      })
    ).resolves.toMatchObject({ status: 401 });
    await gateway?.shutdown();
    await gateway?.shutdown();
    expect(gateway?.diagnostics()).toEqual({
      listening: false,
      activeSessionCount: 0,
      transportCount: 0
    });
  });

  it("discovers only capability-scoped Compazio tools and forwards the authenticated terminal", async () => {
    const calls: unknown[] = [];
    const teams = {
      list: vi.fn(async (workspaceId: string, terminalId: string) => {
        calls.push({ workspaceId, terminalId });
        return { members: [], tasks: [], messages: [], compazio: true };
      })
    } as unknown as TeamCoordinator;
    const scene = await createScene(false, {} as PortalRuntimeManager, ["portal-control"], teams);
    const bootstrap = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: [
        "team-read",
        "team-recruit",
        "team-manage",
        "task-create",
        "task-assign",
        "message-send"
      ]
    });
    if (bootstrap === undefined) throw new Error("Team MCP bootstrap missing");
    client = await connect(bootstrap.endpoint, bootstrap.token);
    const tools = await client.listTools();
    const teamToolNames = tools.tools
      .map((tool) => tool.name)
      .filter(
        (name) =>
          name.startsWith("team_") || name.startsWith("task_") || name.startsWith("message_")
      );
    expect(teamToolNames.sort()).toEqual(
      [
        "team_list",
        "team_recruit",
        "team_status",
        "team_user_input_list",
        "team_dismiss",
        "task_create",
        "task_assign",
        "task_list",
        "task_status",
        "task_result",
        "task_wait",
        "message_send",
        "message_list",
        "message_read",
        "message_acknowledge"
      ].sort()
    );
    expect(teamToolNames).not.toEqual(
      expect.arrayContaining(["team_connect", "task_cancel", "team_run_create"])
    );
    await expect(client.callTool({ name: "team_list", arguments: {} })).resolves.toMatchObject({
      structuredContent: { ok: true, data: { compazio: true } }
    });
    expect(calls).toEqual([{ workspaceId: scene.workspace.id, terminalId: scene.terminalId }]);
  });

  it("registers the strict team run tool only for a Compazio run-management session", async () => {
    const createRun = vi.fn(async () => ({ id: "run_1", status: "planning" }));
    const teams = {
      createRun,
      list: vi.fn(async () => ({ compazio: true, runs: [], members: [], tasks: [], messages: [] }))
    } as unknown as TeamCoordinator;
    const scene = await createScene(false, {} as PortalRuntimeManager, ["portal-control"], teams);
    const bootstrap = gateway?.createAgentSession({
      workspaceId: scene.workspace.id,
      terminalId: scene.terminalId,
      capabilities: ["team-read", "team-run-manage"]
    });
    if (bootstrap === undefined) throw new Error("Team run MCP bootstrap missing");
    client = await connect(bootstrap.endpoint, bootstrap.token);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["team_run_create", "team_run_status", "team_run_cancel"])
    );
    await expect(
      client.callTool({
        name: "team_run_create",
        arguments: {
          title: "API Tasks",
          objective: "Produzir e revisar um contrato de API.",
          members: [
            {
              agentType: "codex",
              displayName: "Codex Implementation Engineer",
              role: { name: "Implementation Engineer", responsibilities: ["Definir a API."] }
            },
            {
              agentType: "opencode",
              displayName: "OpenCode Reviewer",
              role: { name: "Reviewer", responsibilities: ["Revisar a API."] }
            }
          ],
          tasks: [
            {
              key: "implementation",
              title: "Implementar contrato",
              description: "Defina POST /tasks.",
              assignedMemberName: "Codex Implementation Engineer"
            },
            {
              key: "review",
              title: "Revisar contrato",
              description: "Revise o contrato implementado.",
              assignedMemberName: "OpenCode Reviewer",
              dependsOn: ["implementation"]
            }
          ]
        }
      })
    ).resolves.toMatchObject({ structuredContent: { ok: true, data: { id: "run_1" } } });
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: scene.workspace.id,
        compazioTerminalId: scene.terminalId,
        title: "API Tasks"
      })
    );
    await expect(
      client.callTool({
        name: "team_run_create",
        arguments: { title: "incompleta" }
      })
    ).resolves.toMatchObject({ isError: true });
  });

  it("reads and updates newly connected note context without restarting the MCP session", async () => {
    let counter = 0;
    const dependencies = {
      createId: () => `context-${++counter}`,
      now: () => `2026-08-04T12:00:0${counter}.000Z`
    };
    let workspace = createWorkspace(
      { name: "Contexto", workingDirectory: "C:/tmp/context" },
      dependencies
    );
    workspace = addTerminalNode(workspace, { title: "Claude" }, dependencies);
    workspace = addNoteNode(
      workspace,
      { title: "Plano", content: "- [ ] revisar referências" },
      dependencies
    );
    const terminal = workspace.nodes.find((node) => node.type === "terminal");
    const note = workspace.nodes.find((node) => node.type === "note");
    if (terminal?.type !== "terminal" || note?.type !== "note") throw new Error("fixture missing");
    const workspaceService = {
      snapshot: async () => workspace,
      updateNode: async (_workspaceId: string, nodeId: string, patch: Record<string, unknown>) => {
        workspace = updateNode(workspace, nodeId, patch, dependencies);
        return workspace;
      },
      setNoteChecklistItem: async (
        _workspaceId: string,
        nodeId: string,
        line: number,
        checked: boolean
      ) => {
        const current = workspace.nodes.find((node) => node.id === nodeId);
        if (current?.type !== "note") throw new Error("fixture note missing");
        const lines = current.content.split(/\r?\n/);
        lines[line] = (lines[line] ?? "").replace(
          /^(\s*- \[)[ xX](\])/,
          `$1${checked ? "x" : " "}$2`
        );
        workspace = updateNode(workspace, nodeId, { content: lines.join("\n") }, dependencies);
        return workspace;
      }
    } as unknown as V2WorkspaceService;
    gateway = new CompazioMcpGateway(workspaceService, {} as PortalRuntimeManager);
    await gateway.start();
    const bootstrap = gateway.createAgentSession({
      workspaceId: workspace.id,
      terminalId: terminal.id,
      capabilities: []
    });
    client = await connect(bootstrap.endpoint, bootstrap.token);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["context_list", "context_read", "note_update", "note_check"])
    );

    await expect(
      client.callTool({ name: "context_read", arguments: { nodeId: note.id } })
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "PORTAL_NOT_CONNECTED" } }
    });
    await expect(
      client.callTool({
        name: "note_update",
        arguments: { noteId: note.id, content: "blocked", mode: "replace" }
      })
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "PORTAL_NOT_CONNECTED" } }
    });

    // The link is added after the MCP transport exists: discovery and authorization must be live.
    workspace = addVisualEdge(workspace, terminal.id, note.id, dependencies, [
      "read-note",
      "write-note",
      "share-context"
    ]);
    await expect(
      client.callTool({ name: "context_read", arguments: { nodeId: note.id } })
    ).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        data: { title: "Plano", content: "- [ ] revisar referências" }
      }
    });
    await expect(
      client.callTool({
        name: "note_check",
        arguments: { noteId: note.id, line: 0, checked: true }
      })
    ).resolves.toMatchObject({ structuredContent: { ok: true } });
    expect(workspace.nodes.find((node) => node.id === note.id)).toMatchObject({
      content: "- [x] revisar referências"
    });
  });
});

function simplePdf(text: string): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let contents = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(contents));
    contents += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(contents);
  contents += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  contents += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  contents += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(contents, "latin1");
}

async function createScene(
  connectPortal: boolean,
  runtime: PortalRuntimeManager = {} as PortalRuntimeManager,
  capabilities: readonly ("portal-control" | "portal-screenshot" | "portal-close")[] = [
    "portal-control"
  ],
  teams?: TeamCoordinator
): Promise<{
  readonly workspace: Workspace;
  readonly terminalId: string;
  readonly portalId: string;
  revokeEdge(): void;
}> {
  fixture = await startPortalFixture();
  let counter = 0;
  const dependencies = {
    createId: () => `mcp-${++counter}`,
    now: () => "2026-07-29T12:00:00.000Z"
  };
  let workspace = createWorkspace({ name: "MCP", workingDirectory: "C:/tmp/mcp" }, dependencies);
  workspace = addTerminalNode(workspace, { title: "Agente" }, dependencies);
  workspace = addPortalNode(workspace, { url: fixture.baseUrl }, dependencies);
  const terminalId = workspace.nodes.find((node) => node.type === "terminal")?.id;
  const portalId = workspace.nodes.find((node) => node.type === "portal")?.id;
  if (terminalId === undefined || portalId === undefined)
    throw new Error("MCP scene is incomplete");
  if (connectPortal)
    workspace = addVisualEdge(workspace, terminalId, portalId, dependencies, capabilities);
  const workspaceService = {
    snapshot: async (workspaceId: string) => {
      if (workspaceId !== workspace.id) throw new Error("workspace not found");
      return workspace;
    }
  } as unknown as V2WorkspaceService;
  gateway = new CompazioMcpGateway(workspaceService, runtime, teams);
  await gateway.start();
  return {
    workspace,
    terminalId,
    portalId,
    revokeEdge: () => {
      workspace = removeEdge(workspace, workspace.edges[0]?.id ?? "", dependencies);
    }
  };
}

function snapshot() {
  return {
    portalId: "portal",
    title: "Fixture",
    url: "http://127.0.0.1:4100/",
    state: "ready",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    focused: false,
    failure: null
  };
}

async function connect(endpoint: string, token: string): Promise<Client> {
  const value = new Client({ name: "compazio-mcp-probe", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  });
  await value.connect(transport);
  return value;
}
