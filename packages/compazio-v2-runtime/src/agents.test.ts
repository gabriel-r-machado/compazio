import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  defaultAgentCatalog,
  type AgentCatalog,
  type AgentDefinition,
  type AgentPreset
} from "@forgedeck/compazio-v2-domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentRegistry,
  AgentAvailabilityService,
  AgentRuntime,
  PortableRoleService,
  RoleInjectionService,
  WindowsExecutableResolver,
  type CommandRunner,
  type ExecutableResolver
} from "./agents";

const roots: string[] = [];
const now = "2026-07-28T12:00:00.000Z";

class MemoryCatalogStore {
  public catalog: AgentCatalog = defaultAgentCatalog(now);
  public async loadAgentCatalog(): Promise<AgentCatalog> {
    return this.catalog;
  }
  public async saveAgentCatalog(catalog: AgentCatalog): Promise<AgentCatalog> {
    this.catalog = catalog;
    return catalog;
  }
}

class FakeResolver implements ExecutableResolver {
  public constructor(private readonly path: string | null = "C:\\Tools\\codex.cmd") {}
  public async resolve(): Promise<string | null> {
    return this.path;
  }
  public async validate(path: string): Promise<boolean> {
    return path.length > 0 && !path.includes("invalid");
  }
}

class FakeRunner implements CommandRunner {
  public async run(): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }> {
    return { exitCode: 0, stdout: "fake-agent 1.2.3\n", stderr: "" };
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent registry and adapters", () => {
  it("prefers a Windows command shim over an extensionless npm shell script", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-resolver-"));
    roots.push(root);
    await writeFile(join(root, "codex"), "#!/bin/sh\n", "utf8");
    await writeFile(join(root, "codex.cmd"), "@echo off\r\n", "utf8");
    const resolver = new WindowsExecutableResolver(
      { PATH: root, PATHEXT: ".CMD" },
      new FakeRunner()
    );

    await expect(resolver.resolve(["codex"])).resolves.toBe(
      join(root, process.platform === "win32" ? "codex.cmd" : "codex")
    );
  });

  it("rejects duplicate agent definitions", () => {
    const definition: AgentDefinition = {
      id: "fake",
      name: "Fake",
      executableCandidates: ["fake"],
      defaultArgs: [],
      capabilities: ["interactive"],
      supportsRoles: true,
      supportsInteractiveTerminal: true,
      createdAt: now,
      updatedAt: now
    };
    expect(() => new AgentRegistry([definition, definition], [])).toThrow(/duplicate/i);
  });

  it("detects a CLI, records its safe cache and resolves a role launch without invented flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-agents-"));
    roots.push(root);
    const store = new MemoryCatalogStore();
    const runtime = new AgentRuntime({
      store,
      roleInjection: new RoleInjectionService(join(root, "sessions")),
      resolver: new FakeResolver(),
      commandRunner: new FakeRunner(),
      now: () => now
    });
    const installation = await runtime.detectOne("codex");
    expect(installation).toMatchObject({ status: "installed", version: "fake-agent 1.2.3" });
    expect(store.catalog.installations).toContainEqual(installation);

    const role = await runtime.createRole({
      name: "Foco",
      instructions: "Teste somente o fluxo solicitado."
    });
    const resolution = await runtime.resolveLaunch(
      {
        workspaceId: "workspace_1",
        terminalNodeId: "terminal_1",
        agentId: "codex",
        workingDirectory: root,
        roleId: role.id
      },
      {
        fileAccess: "ask",
        destructiveActions: "always-ask",
        externalPaths: "always-ask",
        networkAccess: "agent-default"
      },
      "session_1"
    );
    expect(resolution.launch.executable.path).toBe("C:\\Tools\\codex.cmd");
    expect(resolution.launch.args).toEqual(["--no-alt-screen"]);
    expect(resolution.rolePreparation?.initialInput).toBe("");
    expect(resolution.launch.environment.COMPAZIO_ROLE_INSTRUCTIONS).toContain("Teste somente");
    await runtime.cleanupRole("session_1");
    await runtime.cleanupRole("session_1");
  });

  it("preserves each provider's native interactive UI arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-native-ui-"));
    roots.push(root);
    const runtime = new AgentRuntime({
      store: new MemoryCatalogStore(),
      roleInjection: new RoleInjectionService(join(root, "sessions")),
      resolver: new FakeResolver(),
      commandRunner: new FakeRunner(),
      now: () => now
    });
    const policy = {
      fileAccess: "ask" as const,
      destructiveActions: "always-ask" as const,
      externalPaths: "always-ask" as const,
      networkAccess: "agent-default" as const
    };

    for (const agentId of ["claude-code", "codex", "opencode"] as const) {
      await runtime.detectOne(agentId);
      const resolved = await runtime.resolveLaunch(
        {
          workspaceId: "workspace_1",
          terminalNodeId: `terminal_${agentId}`,
          agentId,
          workingDirectory: root
        },
        policy,
        `session_${agentId}`
      );
      expect(resolved.launch.args).toEqual(agentId === "codex" ? ["--no-alt-screen"] : []);
    }
  });

  it("honors an explicit Codex model override for every native interactive session", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-codex-model-"));
    roots.push(root);
    const runtime = new AgentRuntime({
      store: new MemoryCatalogStore(),
      roleInjection: new RoleInjectionService(join(root, "sessions")),
      resolver: new FakeResolver(),
      commandRunner: new FakeRunner(),
      environment: { COMPAZIO_CODEX_MODEL: "gpt-5.6-luna" },
      now: () => now
    });
    await runtime.detectOne("codex");

    const resolved = await runtime.resolveLaunch(
      {
        workspaceId: "workspace_1",
        terminalNodeId: "terminal_codex_model",
        agentId: "codex",
        workingDirectory: root
      },
      {
        fileAccess: "ask",
        destructiveActions: "always-ask",
        externalPaths: "always-ask",
        networkAccess: "agent-default"
      },
      "session_codex_model"
    );

    expect(resolved.launch.args).toEqual(["--no-alt-screen", "--model", "gpt-5.6-luna"]);
  });

  it("does not append Codex flags to an explicit executable override", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-codex-override-"));
    roots.push(root);
    const runtime = new AgentRuntime({
      store: new MemoryCatalogStore(),
      roleInjection: new RoleInjectionService(join(root, "sessions")),
      resolver: new FakeResolver(process.execPath),
      commandRunner: new FakeRunner(),
      now: () => now
    });
    await runtime.detectOne("codex");
    const resolved = await runtime.resolveLaunch(
      {
        workspaceId: "workspace_1",
        terminalNodeId: "terminal_custom_codex",
        agentId: "codex",
        workingDirectory: root,
        executableOverride: process.execPath,
        argsOverride: ["-e", "setInterval(() => {}, 1000)"]
      },
      {
        fileAccess: "ask",
        destructiveActions: "always-ask",
        externalPaths: "always-ask",
        networkAccess: "agent-default"
      },
      "session_custom_codex"
    );

    expect(resolved.launch.executable.path).toBe(process.execPath);
    expect(resolved.launch.args).toEqual(["-e", "setInterval(() => {}, 1000)"]);

    const manualInstallation = await runtime.resolveLaunch(
      {
        workspaceId: "workspace_1",
        terminalNodeId: "terminal_manual_codex",
        agentId: "codex",
        workingDirectory: root,
        argsOverride: ["-e", "setInterval(() => {}, 1000)"]
      },
      {
        fileAccess: "ask",
        destructiveActions: "always-ask",
        externalPaths: "always-ask",
        networkAccess: "agent-default"
      },
      "session_manual_codex"
    );
    expect(manualInstallation.launch.args).toEqual(["-e", "setInterval(() => {}, 1000)"]);
  });

  it.runIf(process.platform === "win32")(
    "launches an interactive Codex terminal through the package native binary",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "compazio-v2-codex-native-"));
      roots.push(root);
      const shim = join(root, "codex.cmd");
      const targetTriple =
        process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
      const native = join(
        root,
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        `codex-win32-${process.arch}`,
        "vendor",
        targetTriple,
        "bin",
        "codex.exe"
      );
      await mkdir(dirname(native), { recursive: true });
      await writeFile(shim, "@echo off\r\n", "utf8");
      await writeFile(native, "native fixture", "utf8");
      const runtime = new AgentRuntime({
        store: new MemoryCatalogStore(),
        roleInjection: new RoleInjectionService(join(root, "sessions")),
        resolver: new FakeResolver(shim),
        commandRunner: new FakeRunner(),
        now: () => now
      });
      await runtime.detectOne("codex");

      const resolution = await runtime.resolveLaunch(
        {
          workspaceId: "workspace_1",
          terminalNodeId: "terminal_1",
          agentId: "codex",
          workingDirectory: root
        },
        {
          fileAccess: "ask",
          destructiveActions: "always-ask",
          externalPaths: "always-ask",
          networkAccess: "agent-default"
        },
        "interactive_session_1"
      );

      expect(resolution.launch.transport).toBe("pty");
      expect(resolution.launch.executable).toEqual({ path: native, kind: "native" });
    }
  );

  it("reports authentication separately from an invalid executable during preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-auth-"));
    roots.push(root);
    const runtime = new AgentRuntime({
      store: new MemoryCatalogStore(),
      roleInjection: new RoleInjectionService(join(root, "sessions")),
      resolver: new FakeResolver("C:\\Tools\\opencode.cmd"),
      commandRunner: {
        async run() {
          return { exitCode: 1, stdout: "", stderr: "Please sign in to continue" };
        }
      },
      now: () => now
    });

    const availability = await new AgentAvailabilityService(runtime).check("opencode");
    expect(availability).toMatchObject({
      available: false,
      state: "not-authenticated",
      authState: "required",
      executableResolution: "C:\\Tools\\opencode.cmd"
    });
    expect(availability.installation.error?.code).toBe("AGENT_NOT_AUTHENTICATED");
  });

  it("keeps a private task on a pipe when Windows exposes only the provider shim", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-task-shim-"));
    roots.push(root);
    const runtime = new AgentRuntime({
      store: new MemoryCatalogStore(),
      roleInjection: new RoleInjectionService(join(root, "sessions")),
      resolver: new FakeResolver("C:\\Tools\\codex.cmd"),
      commandRunner: new FakeRunner(),
      now: () => now
    });

    const resolution = await runtime.resolveTaskLaunch(
      {
        workspaceId: "workspace_1",
        terminalNodeId: "terminal_1",
        agentId: "codex",
        workingDirectory: root
      },
      {
        fileAccess: "ask",
        destructiveActions: "always-ask",
        externalPaths: "always-ask",
        networkAccess: "agent-default"
      },
      "task_session_1"
    );

    expect(resolution.launch.transport).toBe("pipe");
    expect(resolution.launch.executable.kind).toBe("native");
    expect(resolution.launch.executable.path).toBe(process.env.ComSpec ?? "cmd.exe");
    expect(resolution.launch.windowsVerbatimArguments).toBe(true);
    expect(resolution.launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(resolution.launch.args[3]).toContain("codex.cmd");
  });

  it("supports validated manual paths and preserves built-in roles", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-agents-"));
    roots.push(root);
    const store = new MemoryCatalogStore();
    const runtime = new AgentRuntime({
      store,
      roleInjection: new RoleInjectionService(join(root, "sessions")),
      resolver: new FakeResolver(),
      commandRunner: new FakeRunner(),
      now: () => now
    });
    await runtime.setExecutablePath("opencode", "C:\\Program Files\\OpenCode\\opencode.cmd");
    expect(store.catalog.manualExecutablePaths.opencode).toContain("OpenCode");
    await expect(runtime.deleteRole("developer")).rejects.toThrow(/internas/i);
    const copied = await runtime.duplicateRole("developer");
    expect(copied.source).toBe("user");
  });
});

describe("portable role files", () => {
  it("discovers validated repository roles, rejects traversal metadata and exports without overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-roles-"));
    roots.push(root);
    const directory = join(root, ".compazio", "roles", "frontend-reviewer");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "role.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "frontend-reviewer",
        name: "Revisor Front-end",
        instructionsFile: "instructions.md",
        source: "repository"
      })
    );
    await writeFile(join(directory, "instructions.md"), "Revise acessibilidade.");
    const service = new PortableRoleService();
    const roles = await service.discover(root);
    expect(roles[0]).toMatchObject({
      id: "frontend-reviewer",
      source: "repository",
      portable: true
    });
    const discovered = roles[0];
    if (discovered === undefined) throw new Error("repository role fixture missing");
    await service.export(root, { ...discovered, id: "exported-role", name: "Exportada" });
    expect(
      await readFile(join(root, ".compazio", "roles", "exported-role", "instructions.md"), "utf8")
    ).toContain("acessibilidade");

    await writeFile(
      join(directory, "role.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "../escape",
        name: "Bad",
        instructionsFile: "instructions.md"
      })
    );
    await expect(service.discover(root)).rejects.toThrow();
  });
});

describe("role injection lifecycle", () => {
  it("keeps two terminal artifacts isolated and cleans each one idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-injection-"));
    roots.push(root);
    const injection = new RoleInjectionService(root);
    const first = await injection.prepare({
      workspaceId: "workspace_1",
      terminalNodeId: "terminal_1",
      sessionId: "session_1",
      role: {
        id: "role_1",
        name: "Primeira",
        instructions: "INSTRUCAO_UM",
        revision: "a".repeat(64),
        source: "user",
        scope: "global",
        portable: false,
        createdAt: now,
        updatedAt: now
      }
    });
    const second = await injection.prepare({
      workspaceId: "workspace_1",
      terminalNodeId: "terminal_2",
      sessionId: "session_2",
      role: {
        id: "role_2",
        name: "Segunda",
        instructions: "INSTRUCAO_DOIS",
        revision: "b".repeat(64),
        source: "user",
        scope: "global",
        portable: false,
        createdAt: now,
        updatedAt: now
      }
    });
    expect(first.instructionsPath).not.toBe(second.instructionsPath);
    await expect(readFile(first.instructionsPath, "utf8")).resolves.toContain("INSTRUCAO_UM");
    await expect(readFile(second.instructionsPath, "utf8")).resolves.toContain("INSTRUCAO_DOIS");
    await injection.cleanup("session_1");
    await injection.cleanup("session_1");
    await expect(readFile(first.instructionsPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(second.instructionsPath, "utf8")).resolves.toContain("INSTRUCAO_DOIS");
  });
});

describe("preset validation", () => {
  it("stores a custom executable-plus-args preset without a shell command string", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-preset-"));
    roots.push(root);
    const runtime = new AgentRuntime({
      store: new MemoryCatalogStore(),
      roleInjection: new RoleInjectionService(join(root, "sessions")),
      resolver: new FakeResolver(),
      commandRunner: new FakeRunner(),
      now: () => now
    });
    const preset: Omit<AgentPreset, "id" | "isBuiltIn" | "createdAt" | "updatedAt"> = {
      name: "Minha CLI",
      agentId: "custom",
      executable: "C:\\Program Files\\Minha CLI\\agent.exe",
      args: ["--interactive", "--project", "."],
      env: {},
      processMode: "pty"
    };
    await expect(runtime.createPreset(preset)).resolves.toMatchObject({
      agentId: "custom",
      args: preset.args
    });
  });

  it("preserves presets created while concurrent agent detections update the catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-preset-race-"));
    roots.push(root);
    let signalStarted!: () => void;
    let releaseDetections!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseDetections = resolve;
    });
    const runner: CommandRunner = {
      async run() {
        signalStarted();
        await gate;
        return { exitCode: 0, stdout: "fake-agent 1.2.3\n", stderr: "" };
      }
    };
    const store = new MemoryCatalogStore();
    const runtime = new AgentRuntime({
      store,
      roleInjection: new RoleInjectionService(join(root, "sessions")),
      resolver: new FakeResolver(),
      commandRunner: runner,
      now: () => now
    });

    const detections = runtime.detectAll();
    await started;
    const preset = await runtime.createPreset({
      name: "Preset concorrente",
      agentId: "custom",
      executable: "C:\\Tools\\fake.exe",
      args: [],
      env: {},
      processMode: "pty"
    });
    releaseDetections();
    await detections;

    await expect(runtime.listPresets()).resolves.toContainEqual(preset);
  });
});
