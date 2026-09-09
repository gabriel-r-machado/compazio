import { randomUUID } from "node:crypto";

import { AgentBridge } from "@forgedeck/agent-adapters";
import type { AdapterRegistry } from "@forgedeck/agent-adapters";
import type {
  RuntimeLifecycleAction,
  RuntimeLifecycleCommand,
  RuntimeLifecycleState,
  RuntimeLifecycleStatus
} from "@forgedeck/local-db";
import type { AgentSpawn, AgentSpawnCanvasEvent } from "@forgedeck/schemas";
import type { ProcessSupervisor } from "@forgedeck/terminal";

import {
  AgentMessageDispatcher,
  type AgentMessageDispatcherServices
} from "./agent-message-dispatcher";
import {
  AgentLifecycleDispatcher,
  type AgentLifecycleDispatcherServices
} from "./agent-lifecycle-dispatcher";
import { AgentSpawnDispatcher, type AgentSpawnDispatcherServices } from "./agent-spawn-dispatcher";
import {
  WorkspaceActivityDispatcher,
  type WorkspaceActivityDispatcherServices
} from "./workspace-activity-dispatcher";
import {
  WorkspaceArtifactDispatcher,
  type WorkspaceArtifactDispatcherServices
} from "./workspace-artifact-dispatcher";
import {
  WorkspaceConnectionDispatcher,
  type WorkspaceConnectionDispatcherServices
} from "./workspace-connection-dispatcher";
import {
  WorkspaceNoteDispatcher,
  type WorkspaceNoteDispatcherServices
} from "./workspace-note-dispatcher";

export interface RuntimeProjectLeaseStore {
  tryAcquire(input: {
    readonly projectId: string;
    readonly ownerId: string;
    readonly acquiredAt: string;
    readonly heartbeatAt: string;
  }): boolean;
  get(projectId: string): { readonly ownerId: string } | null;
  release(projectId: string, ownerId: string): boolean;
  releaseAll(ownerId: string): number;
  heartbeat(ownerId: string, at: string): number;
}

export interface RuntimeLifecycleControlStore {
  claimNext(): RuntimeLifecycleCommand | null;
  markApplied(
    command: RuntimeLifecycleCommand,
    state: RuntimeLifecycleState
  ): RuntimeLifecycleStatus;
  markFailed(command: RuntimeLifecycleCommand, errorCode: string): void;
  recordSystemState(
    action: RuntimeLifecycleAction,
    state: RuntimeLifecycleState,
    actor?: string
  ): RuntimeLifecycleStatus;
}

export interface CompassoRuntimeServices {
  /** Platform-owned process bridge. The runtime owns delivery and lifecycle around it. */
  readonly terminal: ProcessSupervisor;
  readonly adapters: AdapterRegistry;
  readonly projectLeases: RuntimeProjectLeaseStore;
  readonly lifecycle?: RuntimeLifecycleControlStore;
  /** The desktop-owned scheduler command dispatcher. CLI never receives this capability. */
  readonly workflowRunDispatcher?: {
    start(): void;
    stop(): void;
    drain(): Promise<void>;
  };
  readonly agentMessages: AgentMessageDispatcherServices["store"];
  readonly agentSpawns: AgentSpawnDispatcherServices["store"];
  readonly agentLifecycle: AgentLifecycleDispatcherServices["store"];
  readonly artifacts: WorkspaceArtifactDispatcherServices["store"];
  readonly notes: WorkspaceNoteDispatcherServices["store"];
  readonly connections: WorkspaceConnectionDispatcherServices["store"];
  readonly activity: WorkspaceActivityDispatcherServices["store"];
  readonly observeActivity: WorkspaceActivityDispatcherServices["observe"];
  readonly startAgent: AgentSpawnDispatcherServices["startAgent"];
  readonly restartAgent: AgentLifecycleDispatcherServices["restartAgent"];
  readonly releaseSessionContext?: AgentLifecycleDispatcherServices["releaseSessionContext"];
  /** Bound per project and supplied only by the desktop host configuration. */
  readonly maxConcurrentDeliveriesPerProject?: number;
  readonly publishAgentSpawn: (event: AgentSpawnCanvasEvent) => void;
  readonly publishAgentLifecycle: AgentLifecycleDispatcherServices["publish"];
  readonly publishArtifact: WorkspaceArtifactDispatcherServices["publish"];
  readonly publishNote: WorkspaceNoteDispatcherServices["publish"];
  readonly publishConnection: WorkspaceConnectionDispatcherServices["publish"];
  readonly publishActivity: WorkspaceActivityDispatcherServices["publish"];
  readonly now?: () => Date;
  readonly instanceId?: string;
}

/** Raised before a second runtime can take ownership of a project already served elsewhere. */
export class RuntimeProjectConflictError extends Error {
  public constructor(projectId: string) {
    super(`Compasso Runtime is already active for project ${projectId}`);
    this.name = "RuntimeProjectConflictError";
  }
}

/**
 * Renderer-independent composition root for the durable, manual Compasso runtime.
 * Desktop wires native UI callbacks into it; the CLI remains a storage/authenticated local client.
 */
export class CompassoRuntime {
  private readonly instanceId: string;
  private readonly now: () => Date;
  private readonly agentMessageDispatchers = new Map<string, AgentMessageDispatcher>();
  private readonly agentSpawnDispatchers = new Map<string, AgentSpawnDispatcher>();
  private readonly agentLifecycleDispatchers = new Map<string, AgentLifecycleDispatcher>();
  private readonly workspaceArtifactDispatcher: WorkspaceArtifactDispatcher;
  private readonly workspaceNoteDispatcher: WorkspaceNoteDispatcher;
  private readonly workspaceConnectionDispatcher: WorkspaceConnectionDispatcher;
  private readonly workspaceActivityDispatcher: WorkspaceActivityDispatcher;
  private readonly leasedProjectIds = new Set<string>();
  private readonly configuredProjectIds = new Set<string>();
  private controlTimer: ReturnType<typeof setInterval> | null = null;
  private leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private controlsDraining = false;
  private workRunning = false;

  public constructor(private readonly services: CompassoRuntimeServices) {
    this.instanceId = services.instanceId ?? randomUUID();
    this.now = services.now ?? (() => new Date());
    this.workspaceArtifactDispatcher = new WorkspaceArtifactDispatcher({
      store: services.artifacts,
      publish: services.publishArtifact
    });
    this.workspaceNoteDispatcher = new WorkspaceNoteDispatcher({
      store: services.notes,
      publish: services.publishNote
    });
    this.workspaceConnectionDispatcher = new WorkspaceConnectionDispatcher({
      store: services.connections,
      publish: services.publishConnection
    });
    this.workspaceActivityDispatcher = new WorkspaceActivityDispatcher({
      store: services.activity,
      observe: services.observeActivity,
      publish: services.publishActivity
    });
  }

  public get terminal(): ProcessSupervisor {
    return this.services.terminal;
  }

  public acquireProject(projectId: string): boolean {
    if (this.leasedProjectIds.has(projectId)) return false;
    const acquired = this.services.projectLeases.tryAcquire({
      projectId,
      ownerId: this.instanceId,
      acquiredAt: this.now().toISOString(),
      heartbeatAt: this.now().toISOString()
    });
    if (!acquired) throw new RuntimeProjectConflictError(projectId);
    this.leasedProjectIds.add(projectId);
    this.configuredProjectIds.add(projectId);
    this.createProjectDispatchers(projectId);
    return true;
  }

  public releaseProject(projectId: string): void {
    if (!this.leasedProjectIds.delete(projectId)) return;
    this.services.projectLeases.release(projectId, this.instanceId);
    this.configuredProjectIds.delete(projectId);
    this.agentMessageDispatchers.get(projectId)?.stop();
    this.agentSpawnDispatchers.get(projectId)?.stop();
    this.agentLifecycleDispatchers.get(projectId)?.stop();
    this.agentMessageDispatchers.delete(projectId);
    this.agentSpawnDispatchers.delete(projectId);
    this.agentLifecycleDispatchers.delete(projectId);
  }

  public start(): void {
    this.ensureProjectLeases();
    this.startLeaseHeartbeat();
    this.startControlLoop();
    this.startWork();
    this.services.lifecycle?.recordSystemState("start", "running");
  }

  public pause(): void {
    this.stopWork();
    this.services.lifecycle?.recordSystemState("pause", "paused");
  }

  public resume(): void {
    this.ensureProjectLeases();
    this.startLeaseHeartbeat();
    this.startControlLoop();
    this.startWork();
    this.services.lifecycle?.recordSystemState("resume", "running");
  }

  public async drain(): Promise<void> {
    this.services.lifecycle?.recordSystemState("drain", "draining");
    this.stopWork();
    await Promise.all([
      ...[...this.agentMessageDispatchers.values()].map((dispatcher) => dispatcher.drain()),
      ...[...this.agentSpawnDispatchers.values()].map((dispatcher) => dispatcher.drain()),
      ...[...this.agentLifecycleDispatchers.values()].map((dispatcher) => dispatcher.drain()),
      this.workspaceArtifactDispatcher.drain(),
      this.workspaceNoteDispatcher.drain(),
      this.workspaceConnectionDispatcher.drain(),
      this.workspaceActivityDispatcher.drain(),
      this.services.workflowRunDispatcher?.drain() ?? Promise.resolve()
    ]);
    this.services.lifecycle?.recordSystemState("drain", "paused");
  }

  public async cancel(): Promise<void> {
    this.stopWork();
    await this.services.terminal.shutdown();
    this.services.lifecycle?.recordSystemState("cancel", "cancelled");
  }

  public async shutdown(): Promise<void> {
    await this.cancel();
    this.releaseAllProjectLeases();
    this.stopLeaseHeartbeat();
    this.services.lifecycle?.recordSystemState("shutdown", "shutdown");
  }

  /** Records the host's explicit shutdown policy after the platform has stopped all PTYs. */
  public recordHostShutdown(): void {
    this.stopWork();
    this.services.lifecycle?.recordSystemState("shutdown", "shutdown", "desktop-runtime");
  }

  /** Ends the host-owned control loop during Electron process teardown. */
  public dispose(): void {
    this.stopWork();
    if (this.controlTimer !== null) clearInterval(this.controlTimer);
    this.controlTimer = null;
    this.releaseAllProjectLeases();
    this.stopLeaseHeartbeat();
  }

  private startWork(): void {
    if (this.workRunning) return;
    this.workRunning = true;
    for (const dispatcher of this.agentMessageDispatchers.values()) dispatcher.start();
    for (const dispatcher of this.agentSpawnDispatchers.values()) dispatcher.start();
    for (const dispatcher of this.agentLifecycleDispatchers.values()) dispatcher.start();
    this.workspaceArtifactDispatcher.start();
    this.workspaceNoteDispatcher.start();
    this.workspaceConnectionDispatcher.start();
    this.workspaceActivityDispatcher.start();
    this.services.workflowRunDispatcher?.start();
  }

  private stopWork(): void {
    if (!this.workRunning) return;
    for (const dispatcher of this.agentMessageDispatchers.values()) dispatcher.stop();
    for (const dispatcher of this.agentSpawnDispatchers.values()) dispatcher.stop();
    for (const dispatcher of this.agentLifecycleDispatchers.values()) dispatcher.stop();
    this.workspaceArtifactDispatcher.stop();
    this.workspaceNoteDispatcher.stop();
    this.workspaceConnectionDispatcher.stop();
    this.workspaceActivityDispatcher.stop();
    this.services.workflowRunDispatcher?.stop();
    this.workRunning = false;
  }

  private ensureProjectLeases(): void {
    for (const projectId of this.configuredProjectIds) {
      if (!this.leasedProjectIds.has(projectId)) this.acquireProject(projectId);
    }
  }

  private createProjectDispatchers(projectId: string): void {
    if (this.agentMessageDispatchers.has(projectId)) return;
    const bridge = new AgentBridge(this.services.adapters);
    const deliveryConcurrency =
      this.services.maxConcurrentDeliveriesPerProject === undefined
        ? {}
        : { maxConcurrentDeliveries: this.services.maxConcurrentDeliveriesPerProject };
    const messages = new AgentMessageDispatcher({
      store: this.services.agentMessages,
      adapters: this.services.adapters,
      terminal: this.services.terminal,
      bridge,
      projectId,
      ...deliveryConcurrency
    });
    const spawns = new AgentSpawnDispatcher({
      store: this.services.agentSpawns,
      startAgent: this.services.startAgent,
      stopAgent: (sessionId) => this.services.terminal.cancel(sessionId),
      publish: this.services.publishAgentSpawn,
      projectId,
      ...deliveryConcurrency
    });
    const lifecycle = new AgentLifecycleDispatcher({
      store: this.services.agentLifecycle,
      stopAgent: (sessionId) => this.services.terminal.cancel(sessionId),
      restartAgent: this.services.restartAgent,
      ...(this.services.releaseSessionContext === undefined
        ? {}
        : { releaseSessionContext: this.services.releaseSessionContext }),
      publish: this.services.publishAgentLifecycle,
      projectId
    });
    this.agentMessageDispatchers.set(projectId, messages);
    this.agentSpawnDispatchers.set(projectId, spawns);
    this.agentLifecycleDispatchers.set(projectId, lifecycle);
    if (this.workRunning) {
      messages.start();
      spawns.start();
      lifecycle.start();
    }
  }

  private releaseAllProjectLeases(): void {
    this.services.projectLeases.releaseAll(this.instanceId);
    this.leasedProjectIds.clear();
  }

  private startLeaseHeartbeat(): void {
    if (this.leaseHeartbeatTimer !== null) return;
    this.leaseHeartbeatTimer = setInterval(
      () => this.services.projectLeases.heartbeat(this.instanceId, this.now().toISOString()),
      5_000
    );
    this.leaseHeartbeatTimer.unref();
  }

  private stopLeaseHeartbeat(): void {
    if (this.leaseHeartbeatTimer !== null) clearInterval(this.leaseHeartbeatTimer);
    this.leaseHeartbeatTimer = null;
  }

  private startControlLoop(): void {
    if (this.services.lifecycle === undefined || this.controlTimer !== null) return;
    this.controlTimer = setInterval(() => void this.drainControls(), 250);
    this.controlTimer.unref();
    void this.drainControls();
  }

  private async drainControls(): Promise<void> {
    const lifecycle = this.services.lifecycle;
    if (lifecycle === undefined || this.controlsDraining) return;
    this.controlsDraining = true;
    try {
      for (;;) {
        const command = lifecycle.claimNext();
        if (command === null) return;
        try {
          const state = await this.applyControl(command.action);
          lifecycle.markApplied(command, state);
        } catch {
          lifecycle.markFailed(command, "runtime_control_failed");
        }
      }
    } finally {
      this.controlsDraining = false;
    }
  }

  private async applyControl(action: RuntimeLifecycleAction): Promise<RuntimeLifecycleState> {
    if (action === "start") {
      this.ensureProjectLeases();
      this.startLeaseHeartbeat();
      this.startWork();
      return "running";
    }
    if (action === "pause") {
      this.stopWork();
      return "paused";
    }
    if (action === "resume") {
      this.ensureProjectLeases();
      this.startLeaseHeartbeat();
      this.startWork();
      return "running";
    }
    if (action === "drain") {
      await this.drain();
      return "paused";
    }
    if (action === "cancel") {
      await this.cancel();
      return "cancelled";
    }
    await this.shutdown();
    return "shutdown";
  }
}

export type CompassoRuntimeAgentSpawn = AgentSpawn;
