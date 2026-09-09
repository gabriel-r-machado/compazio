import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workflowNodeSchema, type WorkflowNode } from "@forgedeck/workflow";
import type {
  CommandResult,
  CommandRunner,
  DetectedExecutable,
  ExecutableDetector,
  RuntimePlatform
} from "@forgedeck/agent-sdk";
import { ProcessTerminalWaitTimeoutError } from "@forgedeck/terminal";
import type { ProcessSessionSnapshot } from "@forgedeck/terminal";
import type { ArtifactReference } from "@forgedeck/workflow";

import { AgentAdapterRegistry, AgentAdapterUnavailableError } from "./agent-adapter-registry";
import {
  ClaudeCodeAgentAdapter,
  redactSensitive,
  type ClaudeCodeAdapterConfig
} from "./claude-code-agent-adapter";
import { CodexAgentAdapter } from "./codex-agent-adapter";
import { OpenCodeAgentAdapter } from "./opencode-agent-adapter";
import { createPlanningSnapshot } from "./planning-snapshot";
import {
  ProcessAgentNodeExecutor,
  type AgentNodeLaunchInput,
  type AgentProcessSupervisor,
  type NodeArtifactStore,
  type ResolvedAgentInput
} from "./process-agent-node-executor";

const NATIVE: DetectedExecutable = { path: "/opt/claude/claude", kind: "native" };

function detectorReturning(executable: DetectedExecutable | null): ExecutableDetector {
  return { find: async () => executable };
}

function runnerReturning(result: Partial<CommandResult>): CommandRunner {
  return {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result })
  };
}

function makeAdapter(options: {
  executable?: DetectedExecutable | null;
  version?: Partial<CommandResult>;
  environment?: Record<string, string | undefined>;
  platform?: RuntimePlatform;
  config?: ClaudeCodeAdapterConfig;
  readShimFile?: (path: string) => Promise<string>;
  fileExists?: (path: string) => Promise<boolean>;
}): ClaudeCodeAgentAdapter {
  return new ClaudeCodeAgentAdapter({
    detector: detectorReturning(options.executable === undefined ? NATIVE : options.executable),
    commandRunner: runnerReturning(options.version ?? { exitCode: 0, stdout: "claude 1.2.3" }),
    platform: options.platform ?? "linux",
    environment: options.environment ?? { PATH: "/usr/bin" },
    // Keep adapter-only unit tests free of real filesystem writes.
    writePromptFile: async () => undefined,
    createDirectory: async () => undefined,
    ...(options.readShimFile === undefined ? {} : { readShimFile: options.readShimFile }),
    ...(options.fileExists === undefined ? {} : { fileExists: options.fileExists }),
    ...(options.config === undefined ? {} : { config: options.config })
  });
}

// A realistic Windows shim (like the installed `claude.cmd`) that invokes a bundled native binary.
const SHIM_TO_NATIVE =
  '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';

function agentNode(overrides: Record<string, unknown> = {}): WorkflowNode {
  return workflowNodeSchema.parse({
    id: "planner",
    type: "agent",
    role: "planner",
    adapter: "claude-code",
    title: "Plan it",
    permissions: {},
    ...overrides
  });
}

function launchInput(
  cwd: string,
  overrides: Partial<AgentNodeLaunchInput> = {}
): AgentNodeLaunchInput {
  return {
    node: agentNode(),
    role: "planner",
    task: "Build the landing page",
    cwd,
    runId: "run-1",
    attempt: 1,
    statePath: join(cwd, ".forgedeck", "planner.state"),
    outputPath: join(cwd, ".forgedeck", "planner.out"),
    inputs: [],
    ...overrides
  };
}

// --- The 18 required unit cases ----------------------------------------------------------------

describe("ClaudeCodeAgentAdapter", () => {
  it("1. exposes the claude-code adapter id", () => {
    expect(makeAdapter({}).id).toBe("claude-code");
  });

  it("2. reports availability when the binary and version are present", async () => {
    const availability = await makeAdapter({
      version: { exitCode: 0, stdout: "claude 1.2.3" }
    }).detect();
    expect(availability.available).toBe(true);
    expect(availability.version).toBe("claude 1.2.3");
    expect(availability.issue).toBeNull();
  });

  it("3. reports unavailability when the binary is absent (and plan fails before any process)", async () => {
    const adapter = makeAdapter({ executable: null });
    const availability = await adapter.detect();
    expect(availability.available).toBe(false);
    expect(availability.issue?.code).toBe("adapter_executable_not_found");
    await expect(adapter.planLaunch(launchInput("/workspace"))).rejects.toBeInstanceOf(
      AgentAdapterUnavailableError
    );
  });

  it("4. keeps controlled args, delivers the prompt on stdin (never argv), over the pipe transport", async () => {
    const plan = await makeAdapter({}).planLaunch(launchInput("/workspace"));
    expect(plan.args).toEqual(["--print", "--permission-mode", "acceptEdits"]);
    expect(plan.args.join(" ")).not.toContain("Build the landing page");
    expect(plan.stdin).toContain("Build the landing page");
    // Single-shot Claude runs over a real stdin pipe, not a pty.
    expect(plan.transport).toBe("pipe");
    // A native executable is launched directly (no shell, no .cmd) — the pipe factory requires it.
    expect(plan.executable.kind).toBe("native");
  });

  it("5. never relies on a shell: args carry no shell metacharacters and stay an array", async () => {
    const plan = await makeAdapter({}).planLaunch(launchInput("/workspace"));
    for (const argument of plan.args) {
      expect(argument).not.toMatch(/[&|<>^();$`]/);
    }
    expect(Array.isArray(plan.args)).toBe(true);
  });

  it("5b. resolves a command-shim to its validated native binary and launches that over the pipe", async () => {
    const adapter = makeAdapter({
      platform: "win32",
      executable: { path: "C:\\npm\\claude.cmd", kind: "command-shim" },
      readShimFile: async () => SHIM_TO_NATIVE,
      fileExists: async () => true
    });
    const plan = await adapter.planLaunch(launchInput("/workspace"));
    // The native binary the shim wraps is launched directly, never the .cmd and never a shell.
    expect(plan.executable.kind).toBe("native");
    expect(plan.executable.path.toLowerCase()).toContain("claude-code\\bin\\claude.exe");
    expect(plan.executable.path.toLowerCase()).not.toContain(".cmd");
    expect(plan.transport).toBe("pipe");
    // The same stdin protocol is used: controlled args, prompt only on stdin.
    expect(plan.args).toEqual(["--print", "--permission-mode", "acceptEdits"]);
    expect(plan.stdin).toContain("Build the landing page");
    expect(plan.args.join(" ")).not.toContain("Build the landing page");
  });

  it("5b-i. reports adapter_unavailable when a command-shim's native binary cannot be resolved", async () => {
    // A shim that does not point at a valid native binary in the expected layout.
    const adapter = makeAdapter({
      platform: "win32",
      executable: { path: "C:\\npm\\claude.cmd", kind: "command-shim" },
      readShimFile: async () => '@ECHO off\r\nnode "%dp0%\\cli.js" %*\r\n',
      fileExists: async () => true
    });
    await expect(adapter.planLaunch(launchInput("/workspace"))).rejects.toBeInstanceOf(
      AgentAdapterUnavailableError
    );
    // Detection reflects the same unlaunchable state.
    const availability = await adapter.detect();
    expect(availability.available).toBe(false);
  });

  it("5b-ii. reports adapter_unavailable when the resolved native binary does not exist", async () => {
    const adapter = makeAdapter({
      platform: "win32",
      executable: { path: "C:\\npm\\claude.cmd", kind: "command-shim" },
      readShimFile: async () => SHIM_TO_NATIVE,
      fileExists: async () => false
    });
    await expect(adapter.planLaunch(launchInput("/workspace"))).rejects.toBeInstanceOf(
      AgentAdapterUnavailableError
    );
  });

  it("5c. preserves newlines, quotes, &, |, %, ! and Unicode in the stdin prompt", async () => {
    const objective = 'Build & ship | 100% "quoted" café ✅ done!\nsecond line\tindented';
    const plan = await makeAdapter({}).planLaunch(launchInput("/workspace", { task: objective }));
    expect(plan.stdin).toContain(objective);
    // None of the special characters leak into argv.
    expect(plan.args.join(" ")).not.toMatch(/[&|%!"✅]/);
  });

  it("5d. rejects an empty objective before any process is built", async () => {
    await expect(
      makeAdapter({}).planLaunch(launchInput("/workspace", { task: "   " }))
    ).rejects.toBeInstanceOf(AgentAdapterUnavailableError);
  });

  it("6. accepts a managed output path inside the workspace", async () => {
    const plan = await makeAdapter({}).planLaunch(
      launchInput("/workspace", { outputPath: "/workspace/.forgedeck/out.json" })
    );
    expect(plan.environment?.COMPAZIO_RESULT_PATH).toBe("/workspace/.forgedeck/out.json");
  });

  it("7. rejects a managed path outside the workspace", async () => {
    await expect(
      makeAdapter({}).planLaunch(launchInput("/workspace", { outputPath: "/etc/passwd" }))
    ).rejects.toBeInstanceOf(AgentAdapterUnavailableError);
    await expect(
      makeAdapter({}).planLaunch(
        launchInput("/workspace", {
          inputs: [upstream("/somewhere/else/plan.json")]
        })
      )
    ).rejects.toBeInstanceOf(AgentAdapterUnavailableError);
  });

  it("8. preserves only the permitted environment keys (local profile + managed result path)", async () => {
    const plan = await makeAdapter({}).planLaunch(launchInput("/workspace"));
    expect(plan.additionalAllowedEnvKeys).toContain("CLAUDE_CONFIG_DIR");
    expect(plan.additionalAllowedEnvKeys).toContain("COMPAZIO_RESULT_PATH");
    expect(Object.keys(plan.environment ?? {}).sort()).toEqual([
      "COMPAZIO_PROMPT_PATH",
      "COMPAZIO_RESULT_PATH"
    ]);
  });

  it("9. removes sensitive values from diagnostics", async () => {
    const adapter = makeAdapter({
      environment: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-secret-value-123456" },
      version: { exitCode: 1, stderr: "boom sk-secret-value-123456 and token=abcd1234" }
    });
    const availability = await adapter.detect();
    expect(availability.available).toBe(false);
    expect(JSON.stringify(availability)).not.toContain("sk-secret-value-123456");
    expect(adapter.sanitize("leak sk-secret-value-123456")).toBe("leak [redacted]");
  });
});

describe("redactSensitive", () => {
  it("18. sanitizes token/cookie/key shapes and known secret values", () => {
    expect(redactSensitive("Authorization: Bearer abcdef12345")).toContain("[redacted]");
    expect(redactSensitive("api_key=supersecretvalue")).toContain("[redacted]");
    expect(redactSensitive("value my-cookie", ["my-cookie"])).toBe("value [redacted]");
  });
});

// --- Executor + adapter through a stub supervisor (no real process, no real Claude) -------------

interface StubBehavior {
  readonly writeResult?: string | null;
  readonly exitCode?: number | null;
  readonly state?: ProcessSessionSnapshot["state"];
  readonly timeout?: boolean;
  readonly extraFile?: { readonly path: string; readonly content: string };
}

class StubSupervisor implements AgentProcessSupervisor {
  public startCalls = 0;
  public cancelCalls = 0;
  public lastEnvironment: Readonly<Record<string, string>> = {};
  public lastArgs: readonly string[] = [];
  public lastInitialInput: { readonly data: string; readonly closeAfterWrite: boolean } | undefined;

  public constructor(private readonly behavior: StubBehavior) {}

  public async start(input: {
    readonly launch: {
      readonly args: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
      readonly initialInput?: { readonly data: string; readonly closeAfterWrite: boolean };
    };
  }): Promise<ProcessSessionSnapshot> {
    this.startCalls += 1;
    this.lastEnvironment = input.launch.environment;
    this.lastArgs = input.launch.args;
    this.lastInitialInput = input.launch.initialInput;
    const resultPath = input.launch.environment.COMPAZIO_RESULT_PATH;
    if (this.behavior.writeResult != null && resultPath !== undefined) {
      writeFileSync(resultPath, this.behavior.writeResult, "utf8");
    }
    if (this.behavior.extraFile !== undefined) {
      writeFileSync(this.behavior.extraFile.path, this.behavior.extraFile.content, "utf8");
    }
    return snapshot("running", null);
  }

  public async waitForTerminal(): Promise<ProcessSessionSnapshot> {
    if (this.behavior.timeout === true) throw new ProcessTerminalWaitTimeoutError();
    return snapshot(this.behavior.state ?? "succeeded", this.behavior.exitCode ?? 0);
  }

  public async cancel(): Promise<ProcessSessionSnapshot> {
    this.cancelCalls += 1;
    return snapshot("cancelled", null);
  }
}

function snapshot(
  state: ProcessSessionSnapshot["state"],
  exitCode: number | null
): ProcessSessionSnapshot {
  return {
    id: "session",
    adapterId: "agent:claude-code",
    state,
    processId: 4242,
    startedAt: null,
    endedAt: null,
    exitCode,
    exitSignal: null
  };
}

class StubArtifactStore implements NodeArtifactStore {
  public published: { nodeId: string; content: string }[] = [];
  public constructor(
    private readonly upstream: Map<
      string,
      ArtifactReference & { nodeId: string; nodeRunId: string | null }
    > = new Map()
  ) {}

  public async publishNodeArtifact(input: {
    readonly nodeId: string;
    readonly type: string;
    readonly content: string;
  }): Promise<ArtifactReference> {
    this.published.push({ nodeId: input.nodeId, content: input.content });
    return {
      id: `artifact-${input.nodeId}`,
      type: input.type,
      relative_path: `artifacts/${input.nodeId}.json`,
      sha256: createHash("sha256").update(input.content).digest("hex"),
      media_type: "application/json"
    };
  }

  public getNodeArtifact(_runId: string, nodeId: string) {
    return this.upstream.get(nodeId) ?? null;
  }

  public resolveArtifactPath(reference: ArtifactReference): string {
    return reference.relative_path;
  }
}

function makeContext(abort?: AbortSignal) {
  return {
    runId: "run-1",
    nodeRunId: "noderun-1",
    attempt: 1,
    workflowVersion: "1",
    grantedPermissions: {},
    abortSignal: abort ?? new AbortController().signal
  };
}

describe("ProcessAgentNodeExecutor with ClaudeCodeAgentAdapter", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claude-adapter-unit-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function buildExecutor(supervisor: StubSupervisor, artifacts = new StubArtifactStore()) {
    const registry = new AgentAdapterRegistry([
      makeAdapter({ config: { executablePath: NATIVE.path } })
    ]);
    const executor = new ProcessAgentNodeExecutor(
      supervisor,
      artifacts,
      { resolveRunRoot: () => root },
      registry,
      { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/user/.claude" }
    );
    return { executor, artifacts };
  }

  it("10. succeeds on a valid structural result and publishes the official artifact (13)", async () => {
    const supervisor = new StubSupervisor({ writeResult: '{"status":"ok"}', exitCode: 0 });
    const { executor, artifacts } = buildExecutor(supervisor);
    const result = await executor.execute(agentNode(), makeContext());
    expect(result.success).toBe(true);
    expect(artifacts.published).toHaveLength(1);
    expect(artifacts.published[0]?.content).toBe('{"status":"ok"}');
    // 8: the managed result path reached the process environment.
    expect(supervisor.lastEnvironment.COMPAZIO_RESULT_PATH).toContain(".forgedeck");
    expect(supervisor.lastEnvironment.CLAUDE_CONFIG_DIR).toBe("/home/user/.claude");
    // The prompt was delivered on stdin and stdin was closed after writing.
    expect(supervisor.lastInitialInput?.data).toContain("single-shot delivery agent");
    expect(supervisor.lastInitialInput?.closeAfterWrite).toBe(true);
    expect(supervisor.lastArgs.join(" ")).not.toContain("single-shot delivery agent");
  });

  it("11. treats exit code != 0 as failure even if the process printed success text", async () => {
    const supervisor = new StubSupervisor({
      writeResult: "success",
      exitCode: 17,
      state: "failed"
    });
    const { executor, artifacts } = buildExecutor(supervisor);
    const result = await executor.execute(agentNode(), makeContext());
    expect(result.success).toBe(false);
    expect(artifacts.published).toHaveLength(0);
  });

  it("12. fails when the structural result is absent despite exit 0", async () => {
    const supervisor = new StubSupervisor({ writeResult: null, exitCode: 0, state: "succeeded" });
    const { executor } = buildExecutor(supervisor);
    const result = await executor.execute(agentNode(), makeContext());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("missing_evidence");
  });

  it("14. ignores files the process created but did not declare as the result", async () => {
    const stray = join(root, "stray.txt");
    const supervisor = new StubSupervisor({
      writeResult: '{"ok":true}',
      exitCode: 0,
      extraFile: { path: stray, content: "not an artifact" }
    });
    const { executor, artifacts } = buildExecutor(supervisor);
    const result = await executor.execute(agentNode(), makeContext());
    expect(result.success).toBe(true);
    expect(artifacts.published).toHaveLength(1);
    expect(artifacts.published[0]?.content).toBe('{"ok":true}');
    expect(existsSync(stray)).toBe(true);
  });

  it("15. reports cancellation as a non-success and requests process termination (17)", async () => {
    const controller = new AbortController();
    controller.abort();
    const supervisor = new StubSupervisor({
      writeResult: null,
      state: "cancelled",
      exitCode: null
    });
    const { executor, artifacts } = buildExecutor(supervisor);
    const result = await executor.execute(agentNode(), makeContext(controller.signal));
    expect(result.success).toBe(false);
    expect(artifacts.published).toHaveLength(0);
  });

  it("16. maps a timeout to a timeout failure and cancels the session", async () => {
    const supervisor = new StubSupervisor({ timeout: true });
    const { executor } = buildExecutor(supervisor);
    const result = await executor.execute(agentNode(), makeContext());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("timeout");
    expect(supervisor.cancelCalls).toBeGreaterThanOrEqual(1);
  });

  it("17. stages a verified upstream artifact from Compazio storage inside the project", async () => {
    const externalRoot = await mkdtemp(join(tmpdir(), "compazio-artifact-"));
    try {
      const externalArtifact = join(externalRoot, "research.json");
      const content = '{"stack":"vite"}';
      writeFileSync(externalArtifact, content, "utf8");
      const artifacts = new StubArtifactStore(
        new Map([
          [
            "research",
            {
              id: "artifact-research",
              type: "claude-code-result",
              relative_path: externalArtifact,
              sha256: createHash("sha256").update(content).digest("hex"),
              media_type: "application/json",
              nodeId: "research",
              nodeRunId: "research-run"
            }
          ]
        ])
      );
      const supervisor = new StubSupervisor({ writeResult: '{"status":"ok"}', exitCode: 0 });
      const { executor } = buildExecutor(supervisor, artifacts);

      await expect(
        executor.execute(agentNode({ depends_on: ["research"] }), makeContext())
      ).resolves.toMatchObject({ success: true });

      const stagedPath = join(root, ".forgedeck", "staging", "run-1", "input-0.artifact");
      expect(readFileSync(stagedPath, "utf8")).toBe(content);
      expect(supervisor.lastInitialInput?.data).toContain(stagedPath);
      expect(supervisor.lastInitialInput?.data).not.toContain(externalArtifact);
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});

// --- The managed evidence path contract --------------------------------------------------------

/**
 * Claude runs with `--print --permission-mode acceptEdits`, which auto-approves file edits but not
 * shell commands, so an agent told only the NAME of an environment variable has no approved way to
 * learn its value: it writes the project files, exits 0, and the runtime correctly fails the node for
 * missing evidence. The prompt therefore carries the literal managed path as well.
 */
function managedPathFromPrompt(prompt: string): string {
  const encoded = prompt
    .split("\n")
    .find((line) => line.startsWith('"') && line.endsWith('"') && line.length > 2);
  if (encoded === undefined) throw new Error("The prompt carries no JSON-encoded managed path");
  const parsed: unknown = JSON.parse(encoded);
  if (typeof parsed !== "string") throw new Error("The managed path was not a JSON string");
  return parsed;
}

describe("ClaudeCodeAgentAdapter managed evidence path", () => {
  it("names the environment variable and the literal absolute path in the prompt", async () => {
    const outputPath = join("/workspace", ".forgedeck", "planner.out");
    const plan = await makeAdapter({}).planLaunch(launchInput("/workspace", { outputPath }));
    expect(plan.stdin).toContain("COMPAZIO_RESULT_PATH");
    expect(managedPathFromPrompt(plan.stdin ?? "")).toBe(outputPath);
    // The variable stays available too: the prompt is an addition, not a replacement.
    expect(plan.environment?.["COMPAZIO_RESULT_PATH"]).toBe(outputPath);
  });

  it("keeps the managed path and the prompt off argv", async () => {
    const outputPath = join("/workspace", ".forgedeck", "planner.out");
    const plan = await makeAdapter({}).planLaunch(launchInput("/workspace", { outputPath }));
    expect(plan.args).toEqual(["--print", "--permission-mode", "acceptEdits"]);
    expect(plan.args.join(" ")).not.toContain(outputPath);
    expect(plan.args.join(" ")).not.toContain("COMPAZIO_RESULT_PATH");
  });

  it("instructs the agent to use the path directly instead of resolving it through a shell", async () => {
    const plan = await makeAdapter({}).planLaunch(launchInput("/workspace"));
    expect(plan.stdin).toContain("Use the literal path directly.");
    expect(plan.stdin).toContain("Do not run a shell command to resolve the environment variable.");
    // Exit 0 without the evidence file must never be reported as success by the agent either.
    expect(plan.stdin).toContain("Do not report success unless this file has been written");
  });

  it("preserves separators, spaces and Unicode in the managed path through JSON encoding", async () => {
    const cwd = join("/work", "Ana Lú's project");
    const outputPath = join(cwd, ".forgedeck", "staging", "结果 planner.out");
    const plan = await makeAdapter({}).planLaunch(launchInput(cwd, { outputPath }));
    // Round-tripping the encoded line is the proof: no separator, space or code point was mangled.
    expect(managedPathFromPrompt(plan.stdin ?? "")).toBe(outputPath);
    expect(plan.environment?.["COMPAZIO_RESULT_PATH"]).toBe(outputPath);
  });

  it("only ever hands out a path the executor staged inside the approved workspace", async () => {
    // Outside the workspace root, and a traversal that resolves outside it, are both rejected before
    // any process exists — the literal path can never point somewhere the run does not own.
    await expect(
      makeAdapter({}).planLaunch(launchInput("/workspace", { outputPath: "/etc/passwd" }))
    ).rejects.toBeInstanceOf(AgentAdapterUnavailableError);
    await expect(
      makeAdapter({}).planLaunch(
        launchInput("/workspace", { outputPath: join("/workspace", "..", "escape.out") })
      )
    ).rejects.toBeInstanceOf(AgentAdapterUnavailableError);
  });

  it("rejects a relative managed path", async () => {
    await expect(
      makeAdapter({}).planLaunch(launchInput("/workspace", { outputPath: "planner.out" }))
    ).rejects.toBeInstanceOf(AgentAdapterUnavailableError);
  });

  it("does not require the node objective to mention the variable or the path", async () => {
    const outputPath = join("/workspace", ".forgedeck", "planner.out");
    const objective = [
      "Create a file named design.txt in the current working directory.",
      "Do not create, modify, or delete any other project file."
    ].join("\n");
    const plan = await makeAdapter({}).planLaunch(
      launchInput("/workspace", { outputPath, task: objective })
    );
    expect(objective).not.toContain("COMPAZIO_RESULT_PATH");
    expect(plan.stdin).toContain(objective);
    expect(managedPathFromPrompt(plan.stdin ?? "")).toBe(outputPath);
  });

  it("stays launch-shaped: no scheduler, database or renderer surface is reachable from it", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "claude-code-agent-adapter.ts"),
      "utf8"
    );
    for (const forbidden of [
      "@forgedeck/local-db",
      "@forgedeck/orchestration",
      "better-sqlite3",
      "electron",
      "./workflow-run-runtime"
    ]) {
      expect(source).not.toContain(`from "${forbidden}"`);
    }
  });

  it("leaves the Codex and OpenCode launch contracts untouched", async () => {
    const outputPath = join("/workspace", ".forgedeck", "planner.out");
    const deps = {
      detector: detectorReturning(NATIVE),
      commandRunner: runnerReturning({ exitCode: 0, stdout: "1.0.0" }),
      platform: "linux" as RuntimePlatform,
      environment: { PATH: "/usr/bin" },
      fileExists: async () => false
    };
    const codex = await new CodexAgentAdapter(deps).planLaunch(
      launchInput("/workspace", { outputPath })
    );
    expect(codex.args[0]).toBe("exec");
    expect(codex.args).toContain("--output-last-message");
    expect(codex.args[codex.args.indexOf("--output-last-message") + 1]).toBe(outputPath);
    expect(codex.stdin).not.toContain("Compazio requires a managed evidence file");

    const openCode = await new OpenCodeAgentAdapter(deps).planLaunch(
      launchInput("/workspace", { outputPath })
    );
    expect(openCode.args).toEqual(["run", "--format", "json", "--dir", "/workspace"]);
    // OpenCode already named its own managed path, in its own wording; that is unchanged.
    expect(openCode.stdin).toContain(outputPath);
    expect(openCode.stdin).not.toContain("Compazio requires a managed evidence file");
  });
});

function upstream(path: string): ResolvedAgentInput {
  return {
    nodeId: "planner",
    artifactId: "artifact-planner",
    path,
    sha256: "a".repeat(64),
    mediaType: "application/json"
  };
}

/**
 * Real-filesystem staging. The adapter owns writing its own prompt file, so it must create the managed
 * directory itself: a planning snapshot legitimately starts without one, and every other caller benefits
 * from the adapter not assuming someone else prepared the path.
 */
describe("ClaudeCodeAgentAdapter prompt staging", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "forgedeck-staging-"));
    roots.push(root);
    return root;
  }

  /** No writePromptFile/createDirectory injection: this exercises the real defaults. */
  function realAdapter(): ClaudeCodeAgentAdapter {
    return new ClaudeCodeAgentAdapter({
      detector: detectorReturning(NATIVE),
      commandRunner: runnerReturning({ exitCode: 0, stdout: "claude 2.1.220" }),
      platform: "linux",
      environment: { PATH: "/usr/bin" }
    });
  }

  it("creates a missing parent directory and stages the prompt inside it", async () => {
    const root = await workspace();
    // Deliberately absent, exactly like a fresh planning snapshot.
    const outputPath = join(root, ".forgedeck", "deep", "planner.out");
    expect(existsSync(join(root, ".forgedeck"))).toBe(false);

    const plan = await realAdapter().planLaunch(launchInput(root, { outputPath }));

    expect(existsSync(join(root, ".forgedeck", "deep"))).toBe(true);
    expect(existsSync(`${outputPath}.prompt`)).toBe(true);
    // Both managed paths stay inside the approved workspace and point at the controlled staging area.
    expect(plan.environment?.["COMPAZIO_PROMPT_PATH"]).toBe(`${outputPath}.prompt`);
    expect(plan.environment?.["COMPAZIO_RESULT_PATH"]).toBe(outputPath);
    for (const managed of [outputPath, `${outputPath}.prompt`]) {
      expect(managed.startsWith(root)).toBe(true);
    }
  });

  it("stages the prompt in a planning snapshot that has no .forgedeck directory", async () => {
    const source = await workspace();
    writeFileSync(join(source, "CLAUDE.md"), "# Instructions\n", "utf8");
    writeFileSync(join(source, "package.json"), '{"name":"p"}', "utf8");
    const snapshot = await createPlanningSnapshot({ workspaceRoot: source });
    try {
      // The snapshot never copies `.forgedeck`; staging must still work.
      expect(existsSync(join(snapshot.path, ".forgedeck"))).toBe(false);
      const outputPath = join(snapshot.path, ".forgedeck", "planning.out");
      await realAdapter().planLaunch(launchInput(snapshot.path, { outputPath }));
      expect(existsSync(`${outputPath}.prompt`)).toBe(true);
      // Created empty as internal staging only — it is not a copied project directory.
      expect(existsSync(join(source, ".forgedeck"))).toBe(false);
    } finally {
      await snapshot.dispose();
    }
    // The snapshot, including anything staged into it, is gone.
    expect(existsSync(snapshot.path)).toBe(false);
  });

  it("refuses to stage outside the workspace, so no directory is created there", async () => {
    const root = await workspace();
    const outside = join(tmpdir(), "forgedeck-outside-staging", "planner.out");
    await expect(
      realAdapter().planLaunch(launchInput(root, { outputPath: outside }))
    ).rejects.toBeInstanceOf(AgentAdapterUnavailableError);
    expect(existsSync(join(tmpdir(), "forgedeck-outside-staging"))).toBe(false);
  });

  it("refuses a traversal that escapes the workspace through the staged path", async () => {
    const root = await workspace();
    const traversal = join(root, "..", "forgedeck-traversal-escape", "planner.out");
    await expect(
      realAdapter().planLaunch(launchInput(root, { outputPath: traversal }))
    ).rejects.toBeInstanceOf(AgentAdapterUnavailableError);
    expect(existsSync(join(root, "..", "forgedeck-traversal-escape"))).toBe(false);
  });

  it("turns a staging failure into a sanitized adapter error, before any process starts", async () => {
    const root = await workspace();
    const failing = new ClaudeCodeAgentAdapter({
      detector: detectorReturning(NATIVE),
      commandRunner: runnerReturning({ exitCode: 0, stdout: "claude 2.1.220" }),
      platform: "linux",
      environment: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/user/.claude-secret" },
      createDirectory: async () => {
        const error: NodeJS.ErrnoException = new Error(
          `EACCES: permission denied, mkdir '${join(root, ".forgedeck")}'`
        );
        error.code = "EACCES";
        throw error;
      }
    });
    const failure = await failing
      .planLaunch(launchInput(root, { outputPath: join(root, ".forgedeck", "planner.out") }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentAdapterUnavailableError);
    const message = failure instanceof Error ? failure.message : "";
    // The code is reported; the raw path and the local profile value are not.
    expect(message).toContain("EACCES");
    expect(message).not.toContain(root);
    expect(message).not.toContain(".claude-secret");
  });

  it("reports a write failure separately from a directory failure", async () => {
    const root = await workspace();
    const failing = new ClaudeCodeAgentAdapter({
      detector: detectorReturning(NATIVE),
      commandRunner: runnerReturning({ exitCode: 0, stdout: "claude 2.1.220" }),
      platform: "linux",
      environment: { PATH: "/usr/bin" },
      writePromptFile: async () => {
        const error: NodeJS.ErrnoException = new Error("ENOSPC: no space left on device");
        error.code = "ENOSPC";
        throw error;
      }
    });
    await expect(
      failing.planLaunch(launchInput(root, { outputPath: join(root, ".forgedeck", "planner.out") }))
    ).rejects.toThrow(/prompt file could not be staged: ENOSPC/u);
  });
});
