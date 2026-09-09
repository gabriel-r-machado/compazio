import type { AdapterContext, AgentAdapter, DetectionResult } from "@forgedeck/agent-sdk";

import { ClaudeCodeAdapter } from "./claude-adapter";
import { CodexAdapter } from "./codex-adapter";
import { OpenCodeAdapter } from "./opencode-adapter";
import { ShellAdapter } from "./shell-adapter";

export interface AdapterStatus {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentAdapter["manifest"]["capabilities"];
  readonly detection: DetectionResult;
}

export class AdapterRegistry {
  private readonly adapters: ReadonlyMap<string, AgentAdapter>;

  public constructor(adapters: readonly AgentAdapter[] = defaultAdapters()) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.manifest.id, adapter]));
  }

  public get(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (adapter === undefined) {
      throw new Error(`Unknown adapter: ${id}`);
    }
    return adapter;
  }

  public list(): readonly AgentAdapter[] {
    return [...this.adapters.values()];
  }

  public async inspect(context: AdapterContext): Promise<readonly AdapterStatus[]> {
    return Promise.all(
      this.list().map(async (adapter) => ({
        id: adapter.manifest.id,
        displayName: adapter.manifest.displayName,
        capabilities: adapter.manifest.capabilities,
        detection: await adapter.detect(context)
      }))
    );
  }
}

export function defaultAdapters(): readonly AgentAdapter[] {
  return [new ShellAdapter(), new ClaudeCodeAdapter(), new CodexAdapter(), new OpenCodeAdapter()];
}
