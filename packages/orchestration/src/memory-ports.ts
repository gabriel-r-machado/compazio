import type { ArtifactReference } from "@forgedeck/workflow";

import type {
  ArtifactRegistry,
  FinalReportInput,
  NodeRunSnapshot,
  QualityGateRunRecord,
  QualityGateStore,
  RunEvent,
  ResourceLockManager,
  RunStore,
  WorkflowRunSnapshot
} from "./contracts";

interface LockWaiter {
  readonly ownerId: string;
  readonly resolve: () => void;
}

interface LockState {
  ownerId: string;
  readonly waiters: LockWaiter[];
}

export class InMemoryResourceLockManager implements ResourceLockManager {
  private readonly locks = new Map<string, LockState>();

  public async acquire(resources: readonly string[], ownerId: string): Promise<() => void> {
    const keys = [...new Set(resources)].sort();
    for (const key of keys) {
      await this.acquireOne(key, ownerId);
    }
    return () => {
      for (const key of [...keys].reverse()) {
        this.releaseOne(key, ownerId);
      }
    };
  }

  private async acquireOne(key: string, ownerId: string): Promise<void> {
    const state = this.locks.get(key);
    if (state === undefined) {
      this.locks.set(key, { ownerId, waiters: [] });
      return;
    }
    await new Promise<void>((resolve) => state.waiters.push({ ownerId, resolve }));
  }

  private releaseOne(key: string, ownerId: string): void {
    const state = this.locks.get(key);
    if (state === undefined || state.ownerId !== ownerId) {
      throw new Error(`Resource lock ${key} is not owned by ${ownerId}`);
    }
    const next = state.waiters.shift();
    if (next === undefined) {
      this.locks.delete(key);
      return;
    }
    state.ownerId = next.ownerId;
    next.resolve();
  }
}

export class InMemoryRunStore implements RunStore {
  public readonly runs = new Map<string, WorkflowRunSnapshot>();
  public readonly nodeRuns = new Map<string, NodeRunSnapshot>();
  public readonly events: RunEvent[] = [];

  public async createRun(
    snapshot: WorkflowRunSnapshot,
    _workflow: FinalReportInput["workflow"],
    event: RunEvent
  ): Promise<void> {
    this.runs.set(snapshot.id, snapshot);
    this.events.push(event);
  }

  public async saveRun(snapshot: WorkflowRunSnapshot): Promise<void> {
    this.runs.set(snapshot.id, snapshot);
  }

  public async saveRunWithEvent(snapshot: WorkflowRunSnapshot, event: RunEvent): Promise<void> {
    this.runs.set(snapshot.id, snapshot);
    this.events.push(event);
  }

  public async saveNodeRun(snapshot: NodeRunSnapshot): Promise<void> {
    this.nodeRuns.set(snapshot.id, snapshot);
  }

  public async saveNodeRunWithEvent(snapshot: NodeRunSnapshot, event: RunEvent): Promise<void> {
    this.nodeRuns.set(snapshot.id, snapshot);
    this.events.push(event);
  }

  public async appendEvent(event: RunEvent): Promise<void> {
    this.events.push(event);
  }
}

export class InMemoryArtifactRegistry implements ArtifactRegistry {
  public readonly reports: FinalReportInput[] = [];

  public async createFinalReport(input: FinalReportInput): Promise<ArtifactReference> {
    this.reports.push(input);
    return {
      id: `report-${input.run.id}`,
      type: "run-report",
      relative_path: `.forgedeck/runs/${input.run.id}/reports/final-report.md`,
      sha256: "0".repeat(64),
      media_type: "text/markdown"
    };
  }
}

export class InMemoryQualityGateStore implements QualityGateStore {
  public readonly gateRuns = new Map<string, QualityGateRunRecord>();

  public async saveGateRun(record: QualityGateRunRecord): Promise<void> {
    this.gateRuns.set(record.id, record);
  }

  public async getGateRun(id: string): Promise<QualityGateRunRecord | null> {
    return this.gateRuns.get(id) ?? null;
  }

  public async listGateRuns(worktreeId: string): Promise<readonly QualityGateRunRecord[]> {
    return [...this.gateRuns.values()].filter((record) => record.worktreeId === worktreeId);
  }

  public async recoverGateRuns(at: string): Promise<number> {
    let count = 0;
    for (const [id, record] of this.gateRuns) {
      if (record.state === "running") {
        this.gateRuns.set(id, { ...record, state: "interrupted", endedAt: at });
        count += 1;
      }
    }
    return count;
  }
}
