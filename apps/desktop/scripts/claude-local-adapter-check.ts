/**
 * OPT-IN local check for the real Claude Code adapter. It is NOT part of the common gates and never
 * runs in CI. It may consume Claude credits, so it only runs when explicitly enabled with
 * `COMPAZIO_CLAUDE_LOCAL=1`. It executes one minimal task in a throwaway temporary directory, never
 * touches this repository, and reports which local profile is used without exposing any secret.
 *
 *   COMPAZIO_CLAUDE_LOCAL=1 pnpm test:adapter:claude-local
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExecFileCommandRunner, PathExecutableDetector } from "@forgedeck/agent-adapters";
import {
  PipeProcessFactory,
  ProcessSupervisor,
  PtyProcessFactory,
  TransportProcessFactory
} from "@forgedeck/terminal";
import type { ArtifactReference, WorkflowNode } from "@forgedeck/workflow";
import { workflowNodeSchema } from "@forgedeck/workflow";

import { AgentAdapterRegistry } from "../src/main/agent-adapter-registry";
import { ClaudeCodeAgentAdapter } from "../src/main/claude-code-agent-adapter";
import {
  ProcessAgentNodeExecutor,
  type NodeArtifactStore
} from "../src/main/process-agent-node-executor";

function platform(): "win32" | "darwin" | "linux" {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error("Unsupported platform");
}

function configProfile(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return configDir !== undefined && configDir.length > 0
    ? `CLAUDE_CONFIG_DIR=${configDir}`
    : "default profile (~/.claude)";
}

/** Minimal artifact surface for a one-off probe; it publishes into the temp dir and reads nothing back. */
class EphemeralArtifactStore implements NodeArtifactStore {
  private readonly byNode = new Map<
    string,
    ArtifactReference & { nodeId: string; nodeRunId: string | null }
  >();
  public async publishNodeArtifact(input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly nodeId: string;
    readonly type: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly content: string;
  }): Promise<ArtifactReference> {
    const reference: ArtifactReference = {
      id: `local-${input.nodeId}`,
      type: input.type,
      relative_path: input.filename,
      sha256: createHash("sha256").update(input.content).digest("hex"),
      media_type: input.mediaType
    };
    this.byNode.set(input.nodeId, {
      ...reference,
      nodeId: input.nodeId,
      nodeRunId: input.nodeRunId
    });
    return reference;
  }
  public getNodeArtifact(_runId: string, nodeId: string) {
    return this.byNode.get(nodeId) ?? null;
  }
  public resolveArtifactPath(reference: ArtifactReference): string {
    return reference.relative_path;
  }
}

async function main(): Promise<number> {
  if (process.env.COMPAZIO_CLAUDE_LOCAL !== "1") {
    process.stdout.write(
      "Skipped: set COMPAZIO_CLAUDE_LOCAL=1 to run the opt-in real Claude check (may use credits).\n"
    );
    return 0;
  }

  const environment = process.env;
  const adapter = new ClaudeCodeAgentAdapter({
    detector: new PathExecutableDetector(),
    commandRunner: new ExecFileCommandRunner(),
    platform: platform(),
    environment
  });

  const availability = await adapter.detect();
  process.stdout.write(`Local profile: ${configProfile()}\n`);
  process.stdout.write(
    `Adapter available: ${availability.available} (version ${availability.version ?? "n/a"})\n`
  );
  if (!availability.available) {
    process.stdout.write(`Issue: ${availability.issue?.message ?? "unknown"}\n`);
    return 1;
  }

  const root = await mkdtemp(join(tmpdir(), "claude-local-check-"));
  const supervisor = new ProcessSupervisor(
    new TransportProcessFactory({
      pty: new PtyProcessFactory(platform()),
      pipe: new PipeProcessFactory()
    }),
    { platform: platform() }
  );
  const registry = new AgentAdapterRegistry([adapter]);
  const artifacts = new EphemeralArtifactStore();
  const executor = new ProcessAgentNodeExecutor(
    supervisor,
    artifacts,
    { resolveRunRoot: () => root },
    registry,
    environment
  );
  const node: WorkflowNode = workflowNodeSchema.parse({
    id: "planner",
    type: "agent",
    role: "planner",
    adapter: "claude-code",
    title: 'Write a JSON object {"ok": true} as your structured result. Do nothing else.',
    permissions: {}
  });

  try {
    const result = await executor.execute(node, {
      runId: "local-check",
      nodeRunId: "local-node",
      attempt: 1,
      workflowVersion: "1",
      grantedPermissions: {},
      abortSignal: new AbortController().signal
    });
    process.stdout.write(`Run success: ${result.success}\n`);
    if (result.success) {
      const published = artifacts.getNodeArtifact("local-check", "planner");
      if (published !== null) {
        process.stdout.write(`Artifact published: ${published.id} (${published.type})\n`);
        process.stdout.write(`Artifact sha256: ${published.sha256}\n`);
        const content = await readFile(
          join(root, ".forgedeck", "staging", "local-check", "planner.1.out"),
          "utf8"
        ).catch(() => "(result already consumed)");
        process.stdout.write(`Structured result (first 200 chars): ${content.slice(0, 200)}\n`);
      }
    } else {
      process.stdout.write(
        `Failure reason: ${result.reason} — ${adapter.sanitize(result.message)}\n`
      );
    }
    return result.success ? 0 : 1;
  } finally {
    // Explicit lifecycle teardown, in order: cancel + reap + dispose the supervisor, remove the temp
    // directory, then verify no session remains registered. No process the run started may outlive it.
    await supervisor.close();
    await rm(root, { recursive: true, force: true });
    const remaining = supervisor.listSessions().length;
    process.stdout.write(`Registered sessions after close: ${remaining}\n`);
  }
}

/** Debug-only handle diagnosis (types only — never content, env or paths). */
function reportActiveHandleTypes(): void {
  const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles;
  const handles = getHandles?.() ?? [];
  const types = handles.map((handle) =>
    handle === null || handle === undefined
      ? typeof handle
      : ((handle as { constructor?: { name?: string } }).constructor?.name ?? typeof handle)
  );
  process.stderr.write(`Active handle types after cleanup: ${JSON.stringify(types)}\n`);
}

main()
  .then((code) => {
    process.exitCode = code;
    // The script should now terminate on its own. This unref'd watchdog does not keep the loop alive;
    // it only fires if some resource we failed to dispose is still holding it — then it reports the
    // handle types (debug) and forces a deterministic exit as a last resort, never as a substitute.
    const watchdog = setTimeout(() => {
      process.stderr.write("Watchdog: process did not self-terminate after cleanup.\n");
      reportActiveHandleTypes();
      process.exit(code);
    }, 4_000);
    watchdog.unref();
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `Local Claude check crashed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
