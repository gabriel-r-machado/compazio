import { isAbsolute, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type {
  AgentDirectoryEntry,
  AgentWorkspace,
  SqliteAgentMessageStore,
  SqliteAgentLifecycleStore,
  SqliteAgentSpawnStore,
  SqliteExecutionContextStore,
  SqliteWorkspaceArtifactStore,
  SqliteWorkspaceArtifactFeedbackStore,
  SqliteWorkspaceContractStore,
  SqliteWorkspaceContextStore,
  SqliteWorkspaceConnectionStore,
  SqliteWorkspaceGovernanceStore,
  SqliteWorkspaceHistoryStore,
  SqliteWorkspaceHandoffStore,
  SqliteWorkspaceImpactStore,
  SqliteWorkspaceNoteStore,
  SqliteRuntimeLifecycleStore,
  SqliteSupervisedAutonomyStore,
  SqliteOrchestrationProposalStore,
  SqliteWorkflowRunCommandStore,
  SqliteWorkflowRunStore
} from "@forgedeck/local-db";
import { workspaceHistoryKinds } from "@forgedeck/local-db";
import {
  artifactMemoryViewSchema,
  contextSelectionModeSchema,
  defaultAutonomyConfig,
  workspaceConnectionCreatableTypeSchema
} from "@forgedeck/schemas";
import type {
  AgentSpawnAdapterId,
  ArtifactMemory,
  ArtifactMemoryRelation,
  ArtifactMemoryRelevance,
  ArtifactMemoryStatus,
  ContextSelectionMode,
  DeliveryEvidence,
  ExecutionCheckpointType,
  WorkspaceAgentContext,
  WorkspaceConnectionCreatableType,
  OrchestrationProposal
} from "@forgedeck/schemas";

interface AgentCliStore {
  listWorkspaces(): readonly AgentWorkspace[];
  listAgents(workspaceId: string): readonly AgentDirectoryEntry[];
  enqueue: SqliteAgentMessageStore["enqueue"];
  enqueueBatch: SqliteAgentMessageStore["enqueueBatch"];
  listMessages: SqliteAgentMessageStore["listMessages"];
  getMessage: SqliteAgentMessageStore["get"];
  listInbox: SqliteAgentMessageStore["listInbox"];
  cancelMessage: SqliteAgentMessageStore["cancel"];
  retryMessage: SqliteAgentMessageStore["retry"];
  recordResponse: SqliteAgentMessageStore["recordResponse"];
  listResponses: SqliteAgentMessageStore["listResponses"];
  getAgentProfile: SqliteWorkspaceGovernanceStore["getAgentProfile"];
  getMission: SqliteWorkspaceGovernanceStore["getMission"];
  setMission: SqliteWorkspaceGovernanceStore["setMission"];
  getWorkspaceMemory: SqliteWorkspaceGovernanceStore["getWorkspaceMemory"];
  setWorkspaceMemory: SqliteWorkspaceGovernanceStore["setWorkspaceMemory"];
  createSpawn: SqliteAgentSpawnStore["create"];
  getSpawn: SqliteAgentSpawnStore["get"];
  retrySpawn: SqliteAgentSpawnStore["retry"];
  createLifecycleCommand: SqliteAgentLifecycleStore["create"];
  listLifecycleCommands: SqliteAgentLifecycleStore["list"];
  publishArtifact: SqliteWorkspaceArtifactStore["publish"];
  resolveArtifact: SqliteWorkspaceArtifactStore["resolve"];
  listArtifacts: SqliteWorkspaceArtifactStore["list"];
  createArtifactFeedback: SqliteWorkspaceArtifactFeedbackStore["create"];
  listArtifactFeedback: SqliteWorkspaceArtifactFeedbackStore["list"];
  getArtifactMemory: SqliteWorkspaceContractStore["getArtifactMemory"];
  setArtifactMemory: SqliteWorkspaceContractStore["setArtifactMemory"];
  listArtifactMemories: SqliteWorkspaceContractStore["listArtifactMemories"];
  compareArtifactMemories: SqliteWorkspaceContractStore["compareArtifactMemories"];
  restoreArtifactMemory: SqliteWorkspaceContractStore["restoreArtifactMemory"];
  getArtifactImpact: SqliteWorkspaceImpactStore["getArtifactImpact"];
  createDeliveryContract: SqliteWorkspaceContractStore["createDeliveryContract"];
  getDeliveryContract: SqliteWorkspaceContractStore["getDeliveryContract"];
  listDeliveryContracts: SqliteWorkspaceContractStore["listDeliveryContracts"];
  verifyDeliveryContract: SqliteWorkspaceContractStore["verifyDeliveryContract"];
  buildExecutionContext: SqliteExecutionContextStore["build"];
  checkpointExecutionContext: SqliteExecutionContextStore["checkpoint"];
  getExecutionCheckpoint: SqliteExecutionContextStore["getCheckpoint"];
  listExecutionCheckpoints: SqliteExecutionContextStore["listCheckpoints"];
  createHandoff: SqliteWorkspaceHandoffStore["create"];
  getHandoff: SqliteWorkspaceHandoffStore["get"];
  listHandoffs: SqliteWorkspaceHandoffStore["list"];
  listHandoffEvents: SqliteWorkspaceHandoffStore["listEvents"];
  approveHandoff: SqliteWorkspaceHandoffStore["approve"];
  rejectHandoff: SqliteWorkspaceHandoffStore["reject"];
  cancelHandoff: SqliteWorkspaceHandoffStore["cancel"];
  retryHandoff: SqliteWorkspaceHandoffStore["retry"];
  resolveContext: SqliteWorkspaceContextStore["resolve"];
  createConnection: SqliteWorkspaceConnectionStore["create"];
  listConnections: SqliteWorkspaceConnectionStore["list"];
  showConnection: SqliteWorkspaceConnectionStore["show"];
  removeConnection: SqliteWorkspaceConnectionStore["remove"];
  resolveConnectionNode: SqliteWorkspaceConnectionStore["resolveNode"];
  createNote: SqliteWorkspaceNoteStore["create"];
  writeNote: SqliteWorkspaceNoteStore["write"];
  readNoteContent: SqliteWorkspaceNoteStore["readContent"];
  appendNote: SqliteWorkspaceNoteStore["append"];
  resolveNote: SqliteWorkspaceNoteStore["resolve"];
  listNotes: SqliteWorkspaceNoteStore["list"];
  listHistory: SqliteWorkspaceHistoryStore["list"];
  getWorkflowRun: SqliteWorkflowRunStore["get"];
  listWorkflowRuns: SqliteWorkflowRunStore["list"];
  listWorkflowRunAlternatives: SqliteWorkflowRunStore["listAlternatives"];
  listWorkflowRunEvents: SqliteWorkflowRunStore["listEvents"];
  createOrchestrationProposal: SqliteOrchestrationProposalStore["create"];
  getOrchestrationProposal: SqliteOrchestrationProposalStore["get"];
  listOrchestrationProposals: SqliteOrchestrationProposalStore["list"];
  listOrchestrationProposalEvents: SqliteOrchestrationProposalStore["listEvents"];
  updateOrchestrationProposal: SqliteOrchestrationProposalStore["updateDraft"];
  approveOrchestrationProposal: SqliteOrchestrationProposalStore["approve"];
  rejectOrchestrationProposal: SqliteOrchestrationProposalStore["reject"];
  requestWorkflowRunStart: SqliteWorkflowRunCommandStore["requestStart"];
  requestWorkflowRunControl: SqliteWorkflowRunCommandStore["requestControl"];
  getRuntimeLifecycleStatus: SqliteRuntimeLifecycleStore["getStatus"];
  requestRuntimeLifecycle: SqliteRuntimeLifecycleStore["request"];
  isAutonomyKillSwitchEngaged: SqliteSupervisedAutonomyStore["isKillSwitchEngaged"];
  engageAutonomyKillSwitch: SqliteSupervisedAutonomyStore["engageKillSwitch"];
  releaseAutonomyKillSwitch: SqliteSupervisedAutonomyStore["releaseKillSwitch"];
  listAutonomyDecisions: SqliteSupervisedAutonomyStore["listDecisions"];
}

export interface CompassoCliContext {
  readonly cwd: string;
  readonly store: AgentCliStore;
  readonly write: (line: string) => void;
  /**
   * The environment of the terminal that invoked the CLI. The desktop injects
   * `COMPAZIO_TERMINAL_ID`/`COMPAZIO_WORKSPACE_ID` into every session it starts, which is how an
   * agent can answer "who am I" without being told. Optional so a plain shell still works.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected so a blocking wait can be tested without spending real seconds. */
  readonly clock?: {
    now(): number;
    sleep(milliseconds: number): void;
  };
}

export const COMPAZIO_TERMINAL_ID_ENV = "COMPAZIO_TERMINAL_ID";
export const COMPAZIO_WORKSPACE_ID_ENV = "COMPAZIO_WORKSPACE_ID";

interface ParsedOptions {
  readonly positional: readonly string[];
  readonly workspace: string | null;
  readonly idempotencyKey: string | null;
  readonly batch: string | null;
  readonly from: string | null;
  readonly agent: string | null;
  readonly role: string | null;
  readonly name: string | null;
  readonly title: string | null;
  readonly content: string | null;
  readonly kind: string | null;
  readonly summary: string | null;
  readonly artifact: string | null;
  readonly connectionType: string | null;
  readonly connectionLabel: string | null;
  readonly revision: number | null;
  readonly state: string | null;
  readonly since: string | null;
  readonly until: string | null;
  readonly limit: number | null;
  readonly scope: string | null;
  readonly decisions: string | null;
  readonly constraints: string | null;
  readonly progress: string | null;
  readonly blockers: string | null;
  readonly stack: string | null;
  readonly architecture: string | null;
  readonly patterns: string | null;
  readonly commands: string | null;
  readonly conventions: string | null;
  readonly technicalDecisions: string | null;
  readonly relationships: string | null;
  readonly relevance: string | null;
  readonly artifactStatus: string | null;
  readonly inputs: string | null;
  readonly outputs: string | null;
  readonly criteria: string | null;
  readonly evidence: string | null;
  readonly maxAttempts: number | null;
  readonly maxContextBytes: number | null;
  readonly task: string | null;
  readonly contract: string | null;
  readonly rerunScope: string | null;
  readonly alternativeLabel: string | null;
  readonly contextMode: ContextSelectionMode | null;
  /** Optional parts of a reassigned responsibility. Named apart from mission/contract options so
   * one flag never means two different things depending on the command. */
  readonly roleConstraints: string | null;
  readonly roleDeliverable: string | null;
  readonly roleCriteria: string | null;
  readonly dryRun: boolean;
  readonly wait: boolean;
  readonly timeoutSeconds: number | null;
  readonly json: boolean;
}

/** How long `ask --wait` blocks before giving up, when the caller does not say. */
const DEFAULT_ASK_WAIT_SECONDS = 300;
const ASK_WAIT_POLL_INTERVAL_MS = 500;

export function runCompassoCli(args: readonly string[], context: CompassoCliContext): number {
  const command = args[0];
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    context.write(helpText());
    return 0;
  }
  const options = parseOptions(args.slice(1), command);
  // A terminal the desktop started already knows its workspace, so a `cd` into a subfolder — or a
  // project with more than one workspace — must not make the CLI ambiguous inside that session.
  const workspace = selectWorkspace(
    context.store.listWorkspaces(),
    context.cwd,
    options.workspace ?? context.env?.[COMPAZIO_WORKSPACE_ID_ENV] ?? null
  );

  if (command === "list") {
    if (
      options.positional.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error("list accepts only --from, --workspace and --json");
    }
    const self = resolveSelfReference(options, context);
    const directory = context.store.listAgents(workspace.id);
    const me = resolveAgent(directory, self);
    const connections = context.store
      .listConnections(workspace.id, 500)
      .filter(
        (connection) =>
          connection.sourceNodeId === me.nodeId || connection.targetNodeId === me.nodeId
      )
      .map((connection) => {
        const otherNodeId =
          connection.sourceNodeId === me.nodeId ? connection.targetNodeId : connection.sourceNodeId;
        return {
          connectionId: connection.connectionId,
          type: connection.type,
          direction:
            connection.sourceNodeId === me.nodeId ? ("outgoing" as const) : ("incoming" as const),
          nodeId: otherNodeId,
          title: resolveNodeTitle(context, workspace.id, otherNodeId),
          label: connection.label
        };
      });
    if (options.json) {
      context.write(
        JSON.stringify(
          {
            nodeId: me.nodeId,
            name: me.name,
            role: me.roleName,
            adapter: me.adapterId,
            connections
          },
          null,
          2
        )
      );
      return 0;
    }
    context.write([me.nodeId, me.name, me.roleName ?? "(sem papel)", me.adapterId].join("\t"));
    if (connections.length === 0) {
      context.write("Nenhuma conexão com este agente.");
      return 0;
    }
    for (const connection of connections) {
      context.write(
        [
          connection.direction === "outgoing" ? "->" : "<-",
          connection.type,
          connection.nodeId,
          connection.title,
          connection.label ?? "-"
        ].join("\t")
      );
    }
    return 0;
  }

  if (command === "profile") {
    const [operation, agentReference, extra] = options.positional;
    if (
      operation !== "show" ||
      agentReference === undefined ||
      extra !== undefined ||
      hasGovernanceOptions(options) ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options) ||
      hasMemoryOptions(options) ||
      options.connectionType !== null ||
      options.connectionLabel !== null ||
      options.revision !== null
    ) {
      throw new Error("Usage: compasso profile show <agent> [--workspace <id|name>] [--json]");
    }
    const agent = resolveAgent(context.store.listAgents(workspace.id), agentReference);
    const profile = context.store.getAgentProfile(workspace.id, agent.nodeId);
    context.write(
      options.json
        ? JSON.stringify(profile, null, 2)
        : `${profile.nodeId}\tversion=${profile.version}\t${profile.identity}\t${profile.adapterId}`
    );
    return 0;
  }

  if (command === "mission") {
    const [operation, objective, extra] = options.positional;
    if (operation === "show") {
      if (
        objective !== undefined ||
        hasGovernanceOptions(options) ||
        options.idempotencyKey !== null ||
        options.batch !== null ||
        options.from !== null ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options) ||
        options.connectionType !== null ||
        options.connectionLabel !== null ||
        options.revision !== null
      ) {
        throw new Error("Usage: compasso mission show [--workspace <id|name>] [--json]");
      }
      const mission = context.store.getMission(workspace.id);
      if (mission === null) {
        context.write("Nenhuma missão detalhada configurada neste workspace.");
      } else {
        context.write(
          options.json
            ? JSON.stringify(mission, null, 2)
            : `version=${mission.version}\t${mission.objective}`
        );
      }
      return 0;
    }
    if (
      operation !== "set" ||
      objective === undefined ||
      extra !== undefined ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options) ||
      hasMemoryOptions(options) ||
      options.connectionType !== null ||
      options.connectionLabel !== null ||
      options.revision !== null
    ) {
      throw new Error(
        'Usage: compasso mission set "<objective>" [--scope <item,...>] [--decisions <item,...>] [--constraints <item,...>] [--progress <text>] [--blockers <item,...>]'
      );
    }
    const mission = context.store.setMission({
      workspaceId: workspace.id,
      objective,
      scope: parseList(options.scope),
      decisions: parseList(options.decisions),
      constraints: parseList(options.constraints),
      progress: options.progress ?? "",
      blockers: parseList(options.blockers)
    });
    context.write(
      options.json ? JSON.stringify(mission, null, 2) : `${mission.id}\tversion=${mission.version}`
    );
    return 0;
  }

  if (command === "memory") {
    const [operation, extra] = options.positional;
    if (operation === "show") {
      if (
        extra !== undefined ||
        hasGovernanceOptions(options) ||
        options.idempotencyKey !== null ||
        options.batch !== null ||
        options.from !== null ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options) ||
        options.connectionType !== null ||
        options.connectionLabel !== null ||
        options.revision !== null
      ) {
        throw new Error("Usage: compasso memory show [--workspace <id|name>] [--json]");
      }
      const memory = context.store.getWorkspaceMemory(workspace.id);
      if (memory === null) {
        context.write("Nenhuma memória de workspace configurada.");
      } else {
        context.write(
          options.json
            ? JSON.stringify(memory, null, 2)
            : `version=${memory.version}\tstack=${memory.stack.join(", ") || "-"}`
        );
      }
      return 0;
    }
    if (
      operation !== "set" ||
      extra !== undefined ||
      !hasMemoryOptions(options) ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options) ||
      hasMissionOptions(options) ||
      options.connectionType !== null ||
      options.connectionLabel !== null ||
      options.revision !== null
    ) {
      throw new Error(
        "Usage: compasso memory set [--stack <item,...>] [--architecture <text>] [--patterns <item,...>] [--commands <item,...>] [--conventions <item,...>] [--technical-decisions <item,...>]"
      );
    }
    const memory = context.store.setWorkspaceMemory({
      workspaceId: workspace.id,
      stack: parseList(options.stack),
      architecture: options.architecture ?? "",
      patterns: parseList(options.patterns),
      commands: parseList(options.commands),
      conventions: parseList(options.conventions),
      technicalDecisions: parseList(options.technicalDecisions)
    });
    context.write(
      options.json ? JSON.stringify(memory, null, 2) : `${memory.id}\tversion=${memory.version}`
    );
    return 0;
  }

  if (command === "history") {
    if (
      options.positional.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      options.role !== null ||
      options.name !== null ||
      options.title !== null ||
      options.content !== null ||
      options.kind !== null ||
      options.summary !== null ||
      options.artifact !== null ||
      options.connectionLabel !== null ||
      options.revision !== null
    ) {
      throw new Error(
        "history accepts --workspace, --agent, --type, --state, --since, --until, --limit and --json"
      );
    }
    if (
      options.connectionType !== null &&
      !workspaceHistoryKinds.includes(options.connectionType as never)
    ) {
      throw new Error(`Unknown history type: ${options.connectionType}`);
    }
    const agentNodeId =
      options.agent === null
        ? null
        : resolveAgent(context.store.listAgents(workspace.id), options.agent).nodeId;
    const entries = context.store.listHistory({
      workspaceId: workspace.id,
      agentNodeId,
      kind: options.connectionType as (typeof workspaceHistoryKinds)[number] | null,
      state: options.state,
      since: options.since,
      until: options.until,
      limit: options.limit ?? 100
    });
    if (options.json) {
      context.write(JSON.stringify(entries, null, 2));
      return 0;
    }
    if (entries.length === 0) {
      context.write("Nenhum evento registrado neste workspace.");
      return 0;
    }
    entries.forEach((entry) =>
      context.write(
        [
          entry.occurredAt,
          entry.kind,
          entry.eventType,
          entry.subjectId,
          entry.agentNodeId ?? "-",
          entry.state ?? "-"
        ].join("\t")
      )
    );
    return 0;
  }

  if (command === "inbox") {
    const [agentReference, extra] = options.positional;
    if (
      agentReference === undefined ||
      extra !== undefined ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options) ||
      hasMissionOptions(options) ||
      options.connectionType !== null ||
      options.connectionLabel !== null ||
      options.revision !== null
    ) {
      throw new Error("Usage: compasso inbox <agent> [--workspace <id|name>] [--json]");
    }
    const agent = resolveAgent(context.store.listAgents(workspace.id), agentReference);
    const messages = context.store.listInbox(workspace.id, agent.nodeId, 100);
    if (options.json) {
      context.write(JSON.stringify(messages, null, 2));
      return 0;
    }
    if (messages.length === 0) {
      context.write("Nenhuma mensagem na inbox deste agente.");
      return 0;
    }
    messages.forEach((message) =>
      context.write(
        [
          message.id,
          message.status,
          `from=${message.senderNodeId ?? "user"}`,
          message.createdAt
        ].join("\t")
      )
    );
    return 0;
  }

  if (command === "message") {
    const [operation, messageId, extra] = options.positional;
    if (
      (operation !== "cancel" && operation !== "retry") ||
      messageId === undefined ||
      extra !== undefined ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options) ||
      options.connectionType !== null ||
      options.connectionLabel !== null ||
      options.revision !== null ||
      options.json
    ) {
      throw new Error(
        "Usage: compasso message <cancel|retry> <message-id> [--workspace <id|name>]"
      );
    }
    const current = context.store.getMessage(messageId);
    if (current === null || current.workspaceId !== workspace.id) {
      throw new Error("Agent message does not belong to this workspace");
    }
    const message =
      operation === "cancel"
        ? context.store.cancelMessage(messageId)
        : context.store.retryMessage(messageId);
    context.write(`${message.id}\t${message.status}\tattempt=${message.attempt}`);
    return 0;
  }

  if (command === "agents") {
    if (
      options.positional.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error("agents accepts only --workspace and --json");
    }
    const agents = context.store.listAgents(workspace.id);
    if (options.json) {
      context.write(JSON.stringify(agents, null, 2));
      return 0;
    }
    if (agents.length === 0) {
      context.write("Nenhum agente disponível neste workspace.");
      return 0;
    }
    for (const agent of agents) {
      context.write(
        [
          agent.nodeId,
          agent.roleName ?? agent.name,
          agent.adapterId,
          agent.online ? "online" : "offline"
        ].join("\t")
      );
    }
    return 0;
  }

  if (command === "ask") {
    if (
      options.json ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error(
        "ask does not accept --json, --agent, --role, --name, --title, --content or --kind"
      );
    }
    if (options.timeoutSeconds !== null && !options.wait) {
      throw new Error("--timeout only applies with --wait");
    }
    if (options.wait && options.batch !== null) {
      // One stdout cannot honestly represent several independent answers arriving at different
      // times. Ask each agent separately, or send the batch and read `responses` afterwards.
      throw new Error("--wait cannot be combined with --batch");
    }
    const directory = context.store.listAgents(workspace.id);
    const senderNodeId =
      options.from === null ? null : resolveAgent(directory, options.from).nodeId;
    if (options.batch !== null) {
      const [content, ...extra] = options.positional;
      if (content === undefined || extra.length > 0) {
        throw new Error('Usage: compasso ask --batch <agent,agent> "<message>"');
      }
      const agents = resolveBatchAgents(directory, options.batch);
      const idempotencyBase = options.idempotencyKey ?? randomUUID();
      const messages = context.store.enqueueBatch(
        agents.map((agent) => ({
          workspaceId: workspace.id,
          recipientNodeId: agent.nodeId,
          senderNodeId,
          content,
          idempotencyKey: batchIdempotencyKey(idempotencyBase, agent.nodeId),
          // `--wait` is refused for a batch, so every batched request is delivered normally.
          awaitedBySender: false
        }))
      );
      messages.forEach((message) =>
        context.write(`${message.id}\t${message.status}\t${message.recipientNodeId}`)
      );
      return 0;
    }
    const [target, content, ...extra] = options.positional;
    if (target === undefined || content === undefined || extra.length > 0) {
      throw new Error('Usage: compasso ask <agent> "<message>"');
    }
    const agent = resolveAgent(directory, target);
    const message = context.store.enqueue({
      workspaceId: workspace.id,
      recipientNodeId: agent.nodeId,
      senderNodeId,
      content,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      awaitedBySender: options.wait
    });
    if (!options.wait) {
      context.write(`${message.id}\t${message.status}\t${agent.nodeId}`);
      return 0;
    }
    return awaitAgentResponse(context, workspace.id, message.id, agent.nodeId, options);
  }

  if (command === "status") {
    if (
      options.positional.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error("status accepts only --workspace and --json");
    }
    const messages = context.store.listMessages(workspace.id, 50);
    if (options.json) {
      context.write(JSON.stringify(messages, null, 2));
      return 0;
    }
    if (messages.length === 0) {
      context.write("Nenhuma mensagem registrada neste workspace.");
      return 0;
    }
    messages.forEach((message) =>
      context.write(
        [
          message.id,
          message.recipientNodeId,
          message.status,
          `attempt=${message.attempt}`,
          message.errorCode ?? "-",
          message.updatedAt
        ].join("\t")
      )
    );
    return 0;
  }

  if (command === "respond") {
    if (
      options.json ||
      options.batch !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error(
        "respond does not accept --json, --batch, --agent, --role, --name, --title, --content or --kind"
      );
    }
    const [requestMessageId, content, ...extra] = options.positional;
    if (
      requestMessageId === undefined ||
      content === undefined ||
      extra.length > 0 ||
      options.from === null
    ) {
      throw new Error('Usage: compasso respond <message-id> --from <agent> "<response>"');
    }
    const responder = resolveAgent(context.store.listAgents(workspace.id), options.from);
    const response = context.store.recordResponse({
      requestMessageId,
      workspaceId: workspace.id,
      responderNodeId: responder.nodeId,
      content,
      idempotencyKey: options.idempotencyKey ?? randomUUID()
    });
    context.write(`${response.id}\t${response.status}\t${response.deliveryMessageId ?? "local"}`);
    return 0;
  }

  if (command === "responses") {
    if (
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error("responses accepts only an optional message id, --workspace and --json");
    }
    const [requestMessageId, ...extra] = options.positional;
    if (extra.length > 0) {
      throw new Error("responses accepts at most one message id");
    }
    const responses = context.store.listResponses(workspace.id, requestMessageId ?? null, 50);
    if (options.json) {
      context.write(JSON.stringify(responses, null, 2));
      return 0;
    }
    if (responses.length === 0) {
      context.write("Nenhuma resposta registrada neste workspace.");
      return 0;
    }
    responses.forEach((response) =>
      context.write(
        [
          response.id,
          response.requestMessageId,
          response.responderNodeId,
          response.status,
          response.deliveryMessageId ?? "local",
          response.createdAt
        ].join("\t")
      )
    );
    return 0;
  }

  if (command === "context") {
    const [operation, targetReference, ...extra] = options.positional;
    if (operation === "build") {
      if (
        targetReference === undefined ||
        extra.length > 0 ||
        options.task === null ||
        options.idempotencyKey !== null ||
        options.batch !== null ||
        options.from !== null ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options) ||
        hasArtifactMemoryOptions(options) ||
        hasContractCreateOptions(options)
      ) {
        throw new Error(
          'Usage: compasso context build <agent> --task "<task>" [--contract <contract-id>] [--context-mode <full|intelligent|economical>] [--workspace <id|name>] [--json]'
        );
      }
      const agent = resolveAgent(context.store.listAgents(workspace.id), targetReference);
      const built = context.store.buildExecutionContext({
        workspaceId: workspace.id,
        agentNodeId: agent.nodeId,
        task: options.task,
        contractId: options.contract,
        contextMode: options.contextMode ?? "full"
      });
      context.write(
        options.json
          ? JSON.stringify(built, null, 2)
          : `${built.agentNodeId}\tprofile=${built.profile.version}\tmission=${built.mission?.version ?? "-"}\tmemory=${built.memory?.version ?? "-"}\tsources=${built.connectedContext.sources.length}\tmode=${built.contextSelection?.mode ?? "legacy"}\testimated_tokens=${built.contextSelection?.metrics.estimatedTokens ?? "-"}\tactual_tokens=${built.contextSelection?.metrics.actualTokens ?? "-"}\tcost=${built.contextSelection?.metrics.costStatus ?? "-"}`
      );
      return 0;
    }
    if (
      operation === undefined ||
      targetReference !== undefined ||
      extra.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options) ||
      hasArtifactMemoryOptions(options) ||
      hasContractOptions(options) ||
      options.task !== null ||
      options.contract !== null ||
      options.contextMode !== null
    ) {
      throw new Error(
        "Usage: compasso context <agent> [--from <agent>] [--workspace <id|name>] [--json]"
      );
    }
    const directory = context.store.listAgents(workspace.id);
    const target = resolveAgent(directory, operation);
    const requesterNodeId =
      options.from === null ? null : resolveAgent(directory, options.from).nodeId;
    const agentContext = context.store.resolveContext({
      workspaceId: workspace.id,
      agentNodeId: target.nodeId,
      requesterNodeId
    });
    if (options.json) {
      context.write(JSON.stringify(toPublicContext(agentContext), null, 2));
      return 0;
    }
    context.write(`Missão\n${agentContext.mission}`);
    if (agentContext.sources.length === 0) {
      context.write("Nenhuma nota está conectada diretamente a este agente.");
      return 0;
    }
    for (const source of agentContext.sources) {
      if (source.artifact !== undefined) {
        context.write(
          [
            `Artifact: ${source.title}`,
            `Connection: ${source.contract.label || source.contract.kind}`,
            `SHA-256: ${source.artifact.sha256}`
          ].join("\n")
        );
        continue;
      }
      context.write(
        [
          `${source.kind === "note" ? "Nota" : `Fonte ${source.kind}`}: ${source.title}`,
          `Conexão: ${source.contract.label || source.contract.kind}`,
          ...(source.content === undefined
            ? [`Referência: ${source.reference?.kind ?? source.kind}`]
            : [source.content])
        ].join("\n")
      );
    }
    return 0;
  }

  if (command === "connect") {
    runConnectCommand(options, workspace.id, context);
    return 0;
  }

  if (command === "impact") {
    runImpactCommand(options, workspace.id, context);
    return 0;
  }

  if (command === "checkpoint") {
    runCheckpointCommand(options, workspace.id, context);
    return 0;
  }

  if (command === "proposal") {
    runProposalCommand(options, workspace.id, context);
    return 0;
  }

  if (command === "run") {
    runWorkflowRunCommand(options, workspace.id, context);
    return 0;
  }

  if (command === "runtime") {
    runRuntimeCommand(options, context);
    return 0;
  }

  if (command === "autonomy") {
    const [operation, extra] = options.positional;
    // The global interrupt is a human, local action: no --from, no agent identity.
    if (
      extra !== undefined ||
      options.from !== null ||
      options.batch !== null ||
      options.idempotencyKey !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error(
        "Usage: compasso autonomy <status|kill|release|decisions> [--workspace <id|name>] [--json]"
      );
    }
    if (operation === "status") {
      const engaged = context.store.isAutonomyKillSwitchEngaged(workspace.id);
      context.write(
        options.json
          ? JSON.stringify({ workspaceId: workspace.id, killSwitchEngaged: engaged }, null, 2)
          : engaged
            ? "Kill switch ENGAJADO: nenhuma ação automática prossegue neste workspace."
            : "Kill switch liberado: ações automáticas seguem os limites aprovados."
      );
      return 0;
    }
    if (operation === "kill") {
      context.store.engageAutonomyKillSwitch(workspace.id, "local-user");
      context.write("Kill switch engajado. Toda ação automática deste workspace fica bloqueada.");
      return 0;
    }
    if (operation === "release") {
      context.store.releaseAutonomyKillSwitch(workspace.id);
      context.write("Kill switch liberado. Nada é retomado automaticamente por esta ação.");
      return 0;
    }
    if (operation === "decisions") {
      const limit = options.limit ?? 50;
      const decisions = context.store.listAutonomyDecisions(workspace.id, limit);
      if (options.json) {
        context.write(JSON.stringify(decisions, null, 2));
        return 0;
      }
      if (decisions.length === 0) {
        context.write("Nenhuma decisão automática registrada neste workspace.");
        return 0;
      }
      decisions.forEach((decision) =>
        context.write(
          [
            decision.createdAt,
            decision.actor,
            decision.action,
            decision.outcome,
            decision.rule
          ].join("\t")
        )
      );
      return 0;
    }
    throw new Error(
      "Usage: compasso autonomy <status|kill|release|decisions> [--workspace <id|name>] [--json]"
    );
  }

  if (command === "note") {
    const [operation, reference, appendedContent, ...extra] = options.positional;
    if (operation === "read" || operation === "write") {
      if (reference === undefined || options.batch !== null || options.json) {
        throw new Error(`Usage: compasso note ${operation} <note> [--from <agent>]`);
      }
      const note = context.store.resolveNote(workspace.id, reference);
      if (operation === "read") {
        if (appendedContent !== undefined || extra.length > 0) {
          throw new Error("Usage: compasso note read <note>");
        }
        // Straight from the file when this project keeps notes on disk, so an agent reads what is
        // actually there — including an edit made outside this product a moment ago.
        context.write(context.store.readNoteContent(note));
        return 0;
      }
      const replacement = options.content ?? appendedContent;
      if (replacement === undefined || extra.length > 0) {
        throw new Error('Usage: compasso note write <note> "<content>"');
      }
      const writtenByNodeId =
        options.from === null
          ? null
          : resolveAgent(context.store.listAgents(workspace.id), options.from).nodeId;
      const written = context.store.writeNote({
        workspaceId: workspace.id,
        noteId: note.id,
        content: replacement,
        writtenByNodeId,
        idempotencyKey: options.idempotencyKey ?? randomUUID()
      });
      context.write(`${written.id}	${written.revision}	${written.nodeId}`);
      return 0;
    }
    if (operation === "create") {
      if (
        options.title === null ||
        reference !== undefined ||
        options.json ||
        options.batch !== null ||
        hasSpawnOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options)
      ) {
        throw new Error('Usage: compasso note create --title "<title>" [--content "<content>"]');
      }
      const createdByNodeId =
        options.from === null
          ? null
          : resolveAgent(context.store.listAgents(workspace.id), options.from).nodeId;
      const note = context.store.createNote({
        workspaceId: workspace.id,
        title: options.title,
        content: options.content ?? "",
        createdByNodeId,
        idempotencyKey: options.idempotencyKey ?? randomUUID()
      });
      context.write(`${note.id}\t${note.revision}\t${note.nodeId}`);
      return 0;
    }
    if (operation === "append") {
      if (
        reference === undefined ||
        appendedContent === undefined ||
        extra.length > 0 ||
        options.title !== null ||
        options.content !== null ||
        options.json ||
        options.batch !== null ||
        hasSpawnOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options)
      ) {
        throw new Error('Usage: compasso note append <note> "<content>" [--from <agent>]');
      }
      const note = context.store.resolveNote(workspace.id, reference);
      const appendedByNodeId =
        options.from === null
          ? null
          : resolveAgent(context.store.listAgents(workspace.id), options.from).nodeId;
      const updated = context.store.appendNote({
        workspaceId: workspace.id,
        noteId: note.id,
        content: appendedContent,
        appendedByNodeId,
        idempotencyKey: options.idempotencyKey ?? randomUUID()
      });
      context.write(`${updated.id}\t${updated.revision}\t${updated.nodeId}`);
      return 0;
    }
    if (operation === "list") {
      if (
        reference !== undefined ||
        options.idempotencyKey !== null ||
        options.from !== null ||
        options.batch !== null ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options)
      ) {
        throw new Error("note list accepts only --workspace and --json");
      }
      const notes = context.store.listNotes(workspace.id, 50);
      if (options.json) {
        context.write(JSON.stringify(notes, null, 2));
        return 0;
      }
      if (notes.length === 0) {
        context.write("Nenhuma nota registrada neste workspace.");
        return 0;
      }
      notes.forEach((note) =>
        context.write([note.id, note.title, `revision=${note.revision}`, note.updatedAt].join("\t"))
      );
      return 0;
    }
    if (operation === "show") {
      if (
        reference === undefined ||
        appendedContent !== undefined ||
        options.idempotencyKey !== null ||
        options.from !== null ||
        options.batch !== null ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options)
      ) {
        throw new Error("note show accepts one note reference, --workspace and --json");
      }
      const note = context.store.resolveNote(workspace.id, reference);
      context.write(
        options.json ? JSON.stringify(note, null, 2) : `${note.title}\n${note.content}`
      );
      return 0;
    }
    throw new Error("Usage: compasso note <create|append|list|show>");
  }

  if (command === "artifact") {
    const [operation, reference, ...extra] = options.positional;
    if (operation === "memory") {
      runArtifactMemoryCommand(options, workspace.id, context);
      return 0;
    }
    if (operation === "feedback") {
      runArtifactFeedbackCommand(options, workspace.id, context);
      return 0;
    }
    if (operation === "publish") {
      if (
        reference === undefined ||
        extra.length > 0 ||
        options.title !== null ||
        options.content !== null ||
        options.json ||
        options.batch !== null ||
        hasSpawnOptions(options) ||
        hasHandoffOptions(options) ||
        hasArtifactMemoryOptions(options) ||
        options.task !== null ||
        options.contract !== null
      ) {
        throw new Error("Usage: compasso artifact publish <path> [--kind <kind>] [--from <agent>]");
      }
      const publishedByNodeId =
        options.from === null
          ? null
          : resolveAgent(context.store.listAgents(workspace.id), options.from).nodeId;
      const artifact = context.store.publishArtifact({
        workspaceId: workspace.id,
        sourcePath: reference,
        kind: options.kind ?? "file",
        publishedByNodeId,
        idempotencyKey: options.idempotencyKey ?? randomUUID()
      });
      context.write(
        `${artifact.id}\t${artifact.kind}\t${artifact.relativePath}\t${artifact.sha256}`
      );
      return 0;
    }
    if (operation === "list") {
      if (
        reference !== undefined ||
        options.idempotencyKey !== null ||
        options.from !== null ||
        options.batch !== null ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options) ||
        hasArtifactMemoryOptions(options) ||
        options.task !== null ||
        options.contract !== null
      ) {
        throw new Error("artifact list accepts only --workspace and --json");
      }
      const artifacts = context.store.listArtifacts(workspace.id, 50);
      if (options.json) {
        context.write(JSON.stringify(artifacts, null, 2));
        return 0;
      }
      if (artifacts.length === 0) {
        context.write("Nenhum artefato registrado neste workspace.");
        return 0;
      }
      artifacts.forEach((artifact) =>
        context.write(
          [artifact.id, artifact.kind, artifact.filename, artifact.byteSize, artifact.sha256].join(
            "\t"
          )
        )
      );
      return 0;
    }
    if (operation === "show") {
      if (
        reference === undefined ||
        extra.length > 0 ||
        options.idempotencyKey !== null ||
        options.from !== null ||
        options.batch !== null ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options) ||
        hasArtifactMemoryOptions(options) ||
        options.task !== null ||
        options.contract !== null
      ) {
        throw new Error("artifact show accepts one artifact reference, --workspace and --json");
      }
      const artifact = context.store.resolveArtifact(workspace.id, reference);
      context.write(
        options.json
          ? JSON.stringify(artifact, null, 2)
          : [
              artifact.filename,
              `kind=${artifact.kind}`,
              `path=${artifact.relativePath}`,
              `sha256=${artifact.sha256}`
            ].join("\n")
      );
      return 0;
    }
    throw new Error("Usage: compasso artifact <publish|list|show>");
  }

  if (command === "contract") {
    runContractCommand(options, workspace.id, context);
    return 0;
  }

  if (command === "handoff") {
    const [operation, second, third, ...extra] = options.positional;
    if (operation === "list") {
      if (
        second !== undefined ||
        options.idempotencyKey !== null ||
        options.from !== null ||
        options.batch !== null ||
        options.revision !== null ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options)
      ) {
        throw new Error("handoff list accepts only --workspace and --json");
      }
      const handoffs = context.store.listHandoffs(workspace.id, 50);
      if (options.json) {
        context.write(JSON.stringify(handoffs, null, 2));
        return 0;
      }
      if (handoffs.length === 0) {
        context.write("Nenhuma entrega registrada neste workspace.");
        return 0;
      }
      handoffs.forEach((handoff) =>
        context.write(
          [
            handoff.id,
            handoff.source.title,
            handoff.target.title,
            handoff.status,
            handoff.revision
          ].join("\t")
        )
      );
      return 0;
    }
    if (operation === "show") {
      if (
        second === undefined ||
        third !== undefined ||
        options.idempotencyKey !== null ||
        options.from !== null ||
        options.batch !== null ||
        options.revision !== null ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options)
      ) {
        throw new Error("handoff show accepts one handoff id, --workspace and --json");
      }
      const handoff = context.store.getHandoff(workspace.id, second);
      context.write(
        options.json
          ? JSON.stringify(handoff, null, 2)
          : [
              `${handoff.source.title} -> ${handoff.target.title}`,
              `status=${handoff.status}`,
              handoff.content.summary
            ].join("\n")
      );
      return 0;
    }

    if (operation === "history") {
      if (
        second === undefined ||
        third !== undefined ||
        options.idempotencyKey !== null ||
        options.from !== null ||
        options.batch !== null ||
        options.revision !== null ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options)
      ) {
        throw new Error(
          "Usage: compasso handoff history <handoff-id> [--workspace <id|name>] [--json]"
        );
      }
      const events = context.store.listHandoffEvents(workspace.id, second);
      if (options.json) {
        context.write(JSON.stringify(events, null, 2));
        return 0;
      }
      events.forEach((event) =>
        context.write(
          [
            event.sequence,
            event.type,
            `${event.fromStatus ?? "-"}->${event.toStatus}`,
            event.createdAt
          ].join("\t")
        )
      );
      return 0;
    }

    if (
      operation === "approve" ||
      operation === "reject" ||
      operation === "cancel" ||
      operation === "retry"
    ) {
      if (
        second === undefined ||
        third !== undefined ||
        options.idempotencyKey !== null ||
        options.batch !== null ||
        options.revision === null ||
        options.revision < 1 ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        (operation !== "approve" && operation !== "reject" && options.summary !== null) ||
        options.artifact !== null
      ) {
        throw new Error(
          "Usage: compasso handoff <approve|reject|cancel|retry> <handoff-id> --revision <n> [--summary <text>] [--from <agent>]"
        );
      }
      const directory = context.store.listAgents(workspace.id);
      const actedByNodeId =
        options.from === null ? null : resolveAgent(directory, options.from).nodeId;
      const input = {
        workspaceId: workspace.id,
        handoffId: second,
        expectedRevision: options.revision,
        actedByNodeId
      };
      const handoff =
        operation === "approve"
          ? context.store.approveHandoff({ ...input, summary: options.summary })
          : operation === "reject"
            ? context.store.rejectHandoff({
                ...input,
                reason: options.summary ?? "Rejected during local review"
              })
            : operation === "cancel"
              ? context.store.cancelHandoff(input)
              : context.store.retryHandoff(input);
      context.write(
        options.json
          ? JSON.stringify(handoff, null, 2)
          : `${handoff.id}\t${handoff.status}\trevision=${handoff.revision}`
      );
      return 0;
    }

    const sourceReference = operation === "create" ? second : operation;
    const targetReference = operation === "create" ? third : second;
    const unexpected =
      operation === "create" ? extra.length > 0 : third !== undefined || extra.length > 0;
    if (
      sourceReference === undefined ||
      targetReference === undefined ||
      unexpected ||
      options.idempotencyKey !== null ||
      options.json ||
      options.batch !== null ||
      options.revision !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options)
    ) {
      throw new Error(
        'Usage: compasso handoff <source> <target> [--summary "<summary>"] [--artifact <artifact>] [--from <agent>]'
      );
    }
    const directory = context.store.listAgents(workspace.id);
    const source = resolveAgent(directory, sourceReference);
    const target = resolveAgent(directory, targetReference);
    const createdByNodeId =
      options.from === null ? null : resolveAgent(directory, options.from).nodeId;
    const artifact =
      options.artifact === null
        ? null
        : context.store.resolveArtifact(workspace.id, options.artifact);
    const handoff = context.store.createHandoff({
      workspaceId: workspace.id,
      sourceNodeId: source.nodeId,
      targetNodeId: target.nodeId,
      summary: options.summary ?? "",
      artifact,
      createdByNodeId
    });
    context.write(`${handoff.id}\t${handoff.status}\t${handoff.revision}`);
    return 0;
  }

  if (command === "terminal") {
    return runTerminalCommand(options, workspace.id, context);
  }

  if (command === "agent") {
    const [operation, target, ...extra] = options.positional;
    if (operation !== "status" || extra.length > 0) {
      throw new Error("Usage: compasso agent status [<agent>]");
    }
    const directory = context.store.listAgents(workspace.id);
    const selected = target === undefined ? directory : [resolveAgent(directory, target)];
    if (options.json) {
      context.write(JSON.stringify(selected, null, 2));
      return 0;
    }
    if (selected.length === 0) {
      context.write("Nenhum agente disponível neste workspace.");
      return 0;
    }
    for (const agent of selected) {
      // `online` says a terminal is bound and running. It never says the agent is idle, busy or
      // finished — a terminal's silence proves nothing about the work inside it.
      context.write(
        [
          agent.nodeId,
          agent.name,
          agent.roleName ?? "(sem papel)",
          agent.adapterId,
          agent.online ? "online" : "offline"
        ].join("\t")
      );
    }
    return 0;
  }

  if (command === "spawn") {
    const [operation, spawnId, extra] = options.positional;
    if (operation === "retry") {
      if (
        spawnId === undefined ||
        extra !== undefined ||
        options.idempotencyKey !== null ||
        options.batch !== null ||
        options.from !== null ||
        options.json ||
        hasSpawnOptions(options) ||
        hasNoteOptions(options) ||
        hasArtifactOptions(options) ||
        hasHandoffOptions(options) ||
        options.connectionType !== null ||
        options.connectionLabel !== null ||
        options.revision !== null
      ) {
        throw new Error("Usage: compasso spawn retry <spawn-id> [--workspace <id|name>]");
      }
      const existing = context.store.getSpawn(spawnId);
      if (existing === null || existing.workspaceId !== workspace.id) {
        throw new Error("Agent spawn does not belong to this workspace");
      }
      const spawn = context.store.retrySpawn(spawnId, null);
      context.write(`${spawn.id}\t${spawn.status}\t${spawn.nodeId}`);
      return 0;
    }
    if (
      options.json ||
      options.batch !== null ||
      operation !== undefined ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error(
        "spawn does not accept positional arguments, --json, --batch, --title, --content or --kind"
      );
    }
    if (options.agent === null || options.role === null || options.name === null) {
      throw new Error(
        "Usage: compasso spawn --agent <codex|claude-code> --role <role> --name <name>"
      );
    }
    const requester =
      options.from === null
        ? null
        : resolveAgent(context.store.listAgents(workspace.id), options.from).nodeId;
    const spawn = context.store.createSpawn({
      workspaceId: workspace.id,
      adapterId: resolveSpawnAdapter(options.agent),
      roleName: options.role,
      name: options.name,
      requestedByNodeId: requester,
      idempotencyKey: options.idempotencyKey ?? randomUUID()
    });
    context.write(`${spawn.id}\t${spawn.status}\t${spawn.nodeId}`);
    return 0;
  }

  throw new Error(`Unknown command: ${command}`);
}

/**
 * `terminal` is the agent-facing surface for managing its own team: recruit, dismiss, reassign.
 *
 * `create` is the same durable spawn request `spawn` already makes — kept as one path rather than
 * two, so there is a single place where a new agent comes into existence. `remove` and `assign-role`
 * are queued for the desktop runtime, because ending or restarting a process is something this
 * short-lived CLI process cannot do itself.
 */
function runTerminalCommand(
  options: ParsedOptions,
  workspaceId: string,
  context: CompassoCliContext
): number {
  const [operation, target, ...extra] = options.positional;

  if (operation === "create") {
    if (
      target !== undefined ||
      extra.length > 0 ||
      options.json ||
      options.batch !== null ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error(
        "Usage: compasso terminal create --agent <claude-code|codex> --role <role> --name <name>"
      );
    }
    if (options.agent === null || options.role === null || options.name === null) {
      throw new Error(
        "Usage: compasso terminal create --agent <claude-code|codex> --role <role> --name <name>"
      );
    }
    const requester =
      options.from === null
        ? null
        : resolveAgent(context.store.listAgents(workspaceId), options.from).nodeId;
    const spawn = context.store.createSpawn({
      workspaceId,
      adapterId: resolveSpawnAdapter(options.agent),
      roleName: options.role,
      name: options.name,
      requestedByNodeId: requester,
      idempotencyKey: options.idempotencyKey ?? randomUUID()
    });
    context.write(`${spawn.id}\t${spawn.status}\t${spawn.nodeId}`);
    return 0;
  }

  if (operation === "remove" || operation === "assign-role" || operation === "restart") {
    if (target === undefined || extra.length > 0 || options.json || options.batch !== null) {
      throw new Error(`Usage: compasso terminal ${operation} <agent> [--from <agent>]`);
    }
    const directory = context.store.listAgents(workspaceId);
    const targetNodeId = resolveAgent(directory, target).nodeId;
    const requester = options.from === null ? null : resolveAgent(directory, options.from).nodeId;
    const role = operation === "assign-role" ? requireAssignedRole(options) : null;
    const queued = context.store.createLifecycleCommand({
      workspaceId,
      targetNodeId,
      action:
        operation === "remove" ? "remove" : operation === "restart" ? "restart" : "assign_role",
      role,
      requestedByNodeId: requester,
      idempotencyKey: options.idempotencyKey ?? randomUUID()
    });
    // Queued, not done: the desktop runtime owns the terminal and applies this.
    context.write(`${queued.id}\t${queued.status}\t${queued.targetNodeId}`);
    return 0;
  }

  if (operation === "list") {
    if (target !== undefined || extra.length > 0) {
      throw new Error("Usage: compasso terminal list [--workspace <id|name>] [--json]");
    }
    const commands = context.store.listLifecycleCommands(workspaceId, options.limit ?? 50);
    if (options.json) {
      context.write(JSON.stringify(commands, null, 2));
      return 0;
    }
    if (commands.length === 0) {
      context.write("Nenhum comando de terminal registrado neste workspace.");
      return 0;
    }
    for (const queued of commands) {
      context.write(
        [
          queued.id,
          queued.action,
          queued.targetNodeId,
          queued.status,
          queued.errorCode ?? "-",
          queued.updatedAt
        ].join("\t")
      );
    }
    return 0;
  }

  throw new Error("Usage: compasso terminal <create|remove|assign-role|list>");
}

/**
 * A reassignment must carry the whole responsibility, not a name with empty instructions: a role
 * whose fields were dropped would quietly turn a Reviewer into an agent told nothing.
 */
function requireAssignedRole(options: ParsedOptions): {
  readonly name: string;
  readonly responsibilities: string;
  readonly constraints: string;
  readonly expectedDeliverable: string;
  readonly completionCriteria: string;
} {
  if (options.role === null) {
    throw new Error("assign-role requires --role <name>");
  }
  if (options.content === null) {
    throw new Error('assign-role requires --content "<responsabilidades>"');
  }
  return {
    name: options.role,
    responsibilities: options.content,
    constraints: options.roleConstraints ?? "",
    expectedDeliverable: options.roleDeliverable ?? "",
    completionCriteria: options.roleCriteria ?? ""
  };
}

function runConnectCommand(
  options: ParsedOptions,
  workspaceId: string,
  context: CompassoCliContext
): void {
  const [operation, second, third, ...extra] = options.positional;
  if (operation === "list") {
    if (
      second !== undefined ||
      options.idempotencyKey !== null ||
      options.from !== null ||
      options.batch !== null ||
      options.connectionType !== null ||
      options.connectionLabel !== null ||
      options.revision !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error("connect list accepts only --workspace and --json");
    }
    const connections = context.store.listConnections(workspaceId, 500);
    if (options.json) {
      context.write(JSON.stringify(connections, null, 2));
      return;
    }
    if (connections.length === 0) {
      context.write("Nenhuma conexão registrada neste workspace.");
      return;
    }
    connections.forEach((connection) =>
      context.write(
        [
          connection.connectionId,
          connection.type,
          connection.sourceNodeId,
          connection.targetNodeId,
          connection.label ?? "-",
          `revision=${connection.revision}`
        ].join("\t")
      )
    );
    return;
  }

  if (operation === "show") {
    if (
      second === undefined ||
      third !== undefined ||
      options.idempotencyKey !== null ||
      options.from !== null ||
      options.batch !== null ||
      options.connectionType !== null ||
      options.connectionLabel !== null ||
      options.revision !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error(
        "Usage: compasso connect show <connection-id> [--workspace <id|name>] [--json]"
      );
    }
    const connection = context.store.showConnection(workspaceId, second);
    context.write(
      options.json
        ? JSON.stringify(connection, null, 2)
        : [
            connection.connectionId,
            `${connection.sourceNodeId} -> ${connection.targetNodeId}`,
            `type=${connection.type}`,
            `label=${connection.label ?? "-"}`,
            `revision=${connection.revision}`
          ].join("\n")
    );
    return;
  }

  if (operation === "remove") {
    if (
      second === undefined ||
      third !== undefined ||
      options.batch !== null ||
      options.connectionType !== null ||
      options.connectionLabel !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options)
    ) {
      throw new Error(
        "Usage: compasso connect remove <connection-id> [--from <agent>] [--revision <n>] [--idempotency-key <key>] [--json]"
      );
    }
    const directory = context.store.listAgents(workspaceId);
    const event = context.store.removeConnection({
      workspaceId,
      connectionId: second,
      removedByNodeId: options.from === null ? null : resolveAgent(directory, options.from).nodeId,
      expectedCanvasRevision: options.revision,
      idempotencyKey: options.idempotencyKey ?? randomUUID()
    });
    context.write(
      options.json
        ? JSON.stringify(event, null, 2)
        : `${event.connection.connectionId}\t${event.type}\trevision=${event.canvasRevision}`
    );
    return;
  }

  const sourceReference = operation === "create" ? second : operation;
  const targetReference = operation === "create" ? third : second;
  const unexpected =
    operation === "create" ? extra.length > 0 : third !== undefined || extra.length > 0;
  if (
    sourceReference === undefined ||
    targetReference === undefined ||
    unexpected ||
    options.batch !== null ||
    hasSpawnOptions(options) ||
    hasNoteOptions(options) ||
    hasArtifactOptions(options) ||
    hasHandoffOptions(options)
  ) {
    throw new Error(
      "Usage: compasso connect create <source> <target> [--type <context|handoff|dependency>] [--label <label>] [--from <agent>] [--revision <n>] [--idempotency-key <key>] [--json]"
    );
  }
  const type: WorkspaceConnectionCreatableType = workspaceConnectionCreatableTypeSchema.parse(
    options.connectionType ?? "context"
  );
  const directory = context.store.listAgents(workspaceId);
  const source = context.store.resolveConnectionNode(workspaceId, sourceReference);
  const target = context.store.resolveConnectionNode(workspaceId, targetReference);
  const event = context.store.createConnection({
    workspaceId,
    sourceNodeId: source.nodeId,
    targetNodeId: target.nodeId,
    type,
    label: options.connectionLabel,
    createdByNodeId: options.from === null ? null : resolveAgent(directory, options.from).nodeId,
    expectedCanvasRevision: options.revision,
    idempotencyKey: options.idempotencyKey ?? randomUUID()
  });
  context.write(
    options.json
      ? JSON.stringify(event, null, 2)
      : `${event.connection.connectionId}\t${event.connection.type}\t${event.connection.sourceNodeId}\t${event.connection.targetNodeId}\trevision=${event.canvasRevision}`
  );
}

function runArtifactMemoryCommand(
  options: ParsedOptions,
  workspaceId: string,
  context: CompassoCliContext
): void {
  const [, operation, artifactReference, baseVersionValue, targetVersionValue, ...extra] =
    options.positional;
  if (operation === "show") {
    if (
      artifactReference === undefined ||
      baseVersionValue !== undefined ||
      targetVersionValue !== undefined ||
      extra.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      options.kind !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasHandoffOptions(options) ||
      hasArtifactMemoryOptions(options) ||
      hasContractCreateOptions(options) ||
      options.task !== null ||
      options.contract !== null
    ) {
      throw new Error(
        "Usage: compasso artifact memory show <artifact> [--workspace <id|name>] [--json]"
      );
    }
    const artifact = context.store.resolveArtifact(workspaceId, artifactReference);
    const memory = context.store.getArtifactMemory(workspaceId, artifact.id);
    context.write(
      options.json
        ? JSON.stringify(toPublicArtifactMemory(memory), null, 2)
        : `${memory.artifactId}\tversion=${memory.version}\trelevance=${memory.relevance}\tstatus=${memory.status}`
    );
    return;
  }

  if (operation === "list") {
    if (
      artifactReference === undefined ||
      baseVersionValue !== undefined ||
      targetVersionValue !== undefined ||
      extra.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      options.kind !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasHandoffOptions(options) ||
      hasArtifactMemoryOptions(options) ||
      hasContractOptions(options)
    ) {
      throw new Error(
        "Usage: compasso artifact memory list <artifact> [--workspace <id|name>] [--json]"
      );
    }
    const artifact = context.store.resolveArtifact(workspaceId, artifactReference);
    const memories = context.store.listArtifactMemories(workspaceId, artifact.id, 50);
    context.write(
      options.json
        ? JSON.stringify(memories.map(toPublicArtifactMemory), null, 2)
        : memories
            .map(
              (memory) =>
                `version=${memory.version}\t${memory.relevance}\t${memory.status}\t${memory.createdAt}`
            )
            .join("\n")
    );
    return;
  }

  if (operation === "restore") {
    if (
      artifactReference === undefined ||
      baseVersionValue === undefined ||
      targetVersionValue !== undefined ||
      extra.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      options.kind !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasHandoffOptions(options) ||
      hasArtifactMemoryOptions(options) ||
      hasContractOptions(options)
    ) {
      throw new Error(
        "Usage: compasso artifact memory restore <artifact> <version> [--workspace <id|name>] [--json]"
      );
    }
    const artifact = context.store.resolveArtifact(workspaceId, artifactReference);
    const restored = context.store.restoreArtifactMemory({
      workspaceId,
      artifactId: artifact.id,
      sourceVersion: parseArtifactMemoryVersion(baseVersionValue)
    });
    context.write(
      options.json
        ? JSON.stringify(toPublicArtifactMemory(restored), null, 2)
        : `${restored.artifactId}\tversion=${restored.version}\trestored-from=${restored.restoredFromVersion ?? "unchanged"}`
    );
    return;
  }

  if (operation === "compare") {
    if (
      artifactReference === undefined ||
      baseVersionValue === undefined ||
      targetVersionValue === undefined ||
      extra.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      options.kind !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasHandoffOptions(options) ||
      hasArtifactMemoryOptions(options) ||
      hasContractOptions(options)
    ) {
      throw new Error(
        "Usage: compasso artifact memory compare <artifact> <base-version> <target-version> [--workspace <id|name>] [--json]"
      );
    }
    const artifact = context.store.resolveArtifact(workspaceId, artifactReference);
    const comparison = context.store.compareArtifactMemories({
      workspaceId,
      artifactId: artifact.id,
      baseVersion: parseArtifactMemoryVersion(baseVersionValue),
      targetVersion: parseArtifactMemoryVersion(targetVersionValue)
    });
    context.write(
      options.json
        ? JSON.stringify(comparison, null, 2)
        : [
            `${comparison.artifactId}\t${comparison.baseVersion}->${comparison.targetVersion}`,
            `relationships=+${comparison.addedRelationships.length}/-${comparison.removedRelationships.length}`,
            `relevance=${formatArtifactMemoryChange(comparison.relevance)}`,
            `status=${formatArtifactMemoryChange(comparison.status)}`
          ].join("\t")
    );
    return;
  }

  if (
    operation !== "set" ||
    artifactReference === undefined ||
    baseVersionValue !== undefined ||
    targetVersionValue !== undefined ||
    extra.length > 0 ||
    options.idempotencyKey !== null ||
    options.batch !== null ||
    options.from !== null ||
    options.kind !== null ||
    options.relevance === null ||
    options.artifactStatus === null ||
    hasSpawnOptions(options) ||
    hasNoteOptions(options) ||
    hasHandoffOptions(options) ||
    hasContractOptions(options)
  ) {
    throw new Error(
      "Usage: compasso artifact memory set <artifact> --relevance <required|relevant|optional> --artifact-status <active|superseded|archived> [--relationships <artifact-id:kind,...>] [--workspace <id|name>] [--json]"
    );
  }
  const artifact = context.store.resolveArtifact(workspaceId, artifactReference);
  const memory = context.store.setArtifactMemory({
    workspaceId,
    artifactId: artifact.id,
    relationships: parseArtifactRelationships(options.relationships),
    relevance: options.relevance as ArtifactMemoryRelevance,
    status: options.artifactStatus as ArtifactMemoryStatus
  });
  context.write(
    options.json
      ? JSON.stringify(toPublicArtifactMemory(memory), null, 2)
      : `${memory.artifactId}\tversion=${memory.version}\t${memory.relevance}\t${memory.status}`
  );
}

function runImpactCommand(
  options: ParsedOptions,
  workspaceId: string,
  context: CompassoCliContext
): void {
  const [artifactReference, extra] = options.positional;
  if (
    artifactReference === undefined ||
    extra !== undefined ||
    options.idempotencyKey !== null ||
    options.batch !== null ||
    options.from !== null ||
    hasSpawnOptions(options) ||
    hasNoteOptions(options) ||
    hasArtifactOptions(options) ||
    hasHandoffOptions(options) ||
    hasGovernanceOptions(options) ||
    hasArtifactMemoryOptions(options) ||
    hasContractOptions(options)
  ) {
    throw new Error("Usage: compasso impact <artifact> [--workspace <id|name>] [--json]");
  }
  const artifact = context.store.resolveArtifact(workspaceId, artifactReference);
  const impact = context.store.getArtifactImpact(workspaceId, artifact.id);
  if (options.json) {
    context.write(JSON.stringify(impact, null, 2));
    return;
  }

  const nodes = new Map(impact.nodes.map((node) => [node.artifactId, node]));
  const root = nodes.get(impact.rootArtifactId);
  if (root === undefined) throw new Error("Artifact impact root was not found");
  context.write(
    `${root.filename}\tversion=${root.memoryVersion}\taffected=${impact.affectedArtifactIds.length}`
  );
  for (const edge of impact.edges) {
    const source = nodes.get(edge.sourceArtifactId);
    const target = nodes.get(edge.targetArtifactId);
    if (source === undefined || target === undefined) continue;
    context.write(`${source.filename}\t${edge.kind}\t${target.filename}`);
  }
}

function runArtifactFeedbackCommand(
  options: ParsedOptions,
  workspaceId: string,
  context: CompassoCliContext
): void {
  const [, operation, artifactReference, versionValue, content, ...extra] = options.positional;
  if (operation === "create") {
    if (
      artifactReference === undefined ||
      versionValue === undefined ||
      content === undefined ||
      extra.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      options.kind !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasHandoffOptions(options) ||
      hasArtifactMemoryOptions(options) ||
      hasContractOptions(options)
    ) {
      throw new Error(
        'Usage: compasso artifact feedback create <artifact> <version> "<feedback>" [--workspace <id|name>] [--json]'
      );
    }
    const artifact = context.store.resolveArtifact(workspaceId, artifactReference);
    const feedback = context.store.createArtifactFeedback({
      workspaceId,
      artifactId: artifact.id,
      artifactVersion: parseArtifactMemoryVersion(versionValue),
      content
    });
    context.write(
      options.json
        ? JSON.stringify(feedback, null, 2)
        : `${feedback.id}\t${feedback.artifactId}\tversion=${feedback.artifactVersion}`
    );
    return;
  }

  if (operation === "list") {
    if (
      artifactReference === undefined ||
      content !== undefined ||
      extra.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      options.kind !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasHandoffOptions(options) ||
      hasArtifactMemoryOptions(options) ||
      hasContractOptions(options)
    ) {
      throw new Error(
        "Usage: compasso artifact feedback list <artifact> [version] [--workspace <id|name>] [--json]"
      );
    }
    const artifact = context.store.resolveArtifact(workspaceId, artifactReference);
    const feedback = context.store.listArtifactFeedback(
      workspaceId,
      artifact.id,
      versionValue === undefined ? null : parseArtifactMemoryVersion(versionValue),
      50
    );
    context.write(
      options.json
        ? JSON.stringify(feedback, null, 2)
        : feedback
            .map((entry) => `${entry.id}\tversion=${entry.artifactVersion}\t${entry.content}`)
            .join("\n")
    );
    return;
  }

  throw new Error("Usage: compasso artifact feedback <create|list>");
}

function runContractCommand(
  options: ParsedOptions,
  workspaceId: string,
  context: CompassoCliContext
): void {
  const [operation, second, third, ...extra] = options.positional;
  if (operation === "list") {
    if (
      second !== undefined ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options) ||
      hasContractOptions(options) ||
      hasArtifactMemoryOptions(options)
    ) {
      throw new Error("Usage: compasso contract list [--workspace <id|name>] [--json]");
    }
    const contracts = context.store.listDeliveryContracts(workspaceId, 50);
    context.write(
      options.json
        ? JSON.stringify(contracts, null, 2)
        : contracts
            .map(
              (contract) =>
                `${contract.id}\t${contract.sourceNodeId}->${contract.targetNodeId}\t${contract.state}\tversion=${contract.version}`
            )
            .join("\n")
    );
    return;
  }

  if (operation === "show") {
    if (
      second === undefined ||
      third !== undefined ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options) ||
      hasContractOptions(options) ||
      hasArtifactMemoryOptions(options)
    ) {
      throw new Error(
        "Usage: compasso contract show <contract-id> [--workspace <id|name>] [--json]"
      );
    }
    const contract = context.store.getDeliveryContract(workspaceId, second);
    context.write(
      options.json
        ? JSON.stringify(contract, null, 2)
        : `${contract.id}\t${contract.sourceNodeId}->${contract.targetNodeId}\t${contract.state}\tversion=${contract.version}`
    );
    return;
  }

  if (operation === "verify") {
    if (
      second === undefined ||
      third !== undefined ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      options.evidence === null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options) ||
      hasArtifactMemoryOptions(options) ||
      hasContractCreateOptions(options)
    ) {
      throw new Error(
        "Usage: compasso contract verify <contract-id> --evidence <kind:reference,...> [--workspace <id|name>] [--json]"
      );
    }
    const contract = context.store.verifyDeliveryContract({
      workspaceId,
      contractId: second,
      verifiedEvidence: parseDeliveryEvidence(options.evidence)
    });
    context.write(
      options.json
        ? JSON.stringify(contract, null, 2)
        : `${contract.id}\t${contract.state}\tversion=${contract.version}`
    );
    return;
  }

  const sourceReference = operation === "create" ? second : operation;
  const targetReference = operation === "create" ? third : second;
  const unexpected =
    operation === "create" ? extra.length > 0 : third !== undefined || extra.length > 0;
  if (
    sourceReference === undefined ||
    targetReference === undefined ||
    unexpected ||
    options.idempotencyKey !== null ||
    options.batch !== null ||
    options.from !== null ||
    hasSpawnOptions(options) ||
    hasNoteOptions(options) ||
    hasArtifactOptions(options) ||
    hasHandoffOptions(options) ||
    hasArtifactMemoryOptions(options) ||
    options.task !== null ||
    options.contract !== null
  ) {
    throw new Error(
      "Usage: compasso contract create <source> <target> [--inputs <item,...>] [--outputs <item,...>] [--criteria <item,...>] [--evidence <kind:reference,...>] [--max-attempts <1-10>] [--max-context-bytes <4096-2097152>] [--workspace <id|name>] [--json]"
    );
  }
  const directory = context.store.listAgents(workspaceId);
  const source = resolveAgent(directory, sourceReference);
  const target = resolveAgent(directory, targetReference);
  const contract = context.store.createDeliveryContract({
    workspaceId,
    sourceNodeId: source.nodeId,
    targetNodeId: target.nodeId,
    inputs: parseList(options.inputs),
    outputs: parseList(options.outputs),
    completionCriteria: parseList(options.criteria),
    declaredEvidence: parseDeliveryEvidence(options.evidence),
    limits: {
      maxAttempts: options.maxAttempts ?? 1,
      maxContextBytes: options.maxContextBytes ?? 1024 * 1024
    }
  });
  context.write(
    options.json
      ? JSON.stringify(contract, null, 2)
      : `${contract.id}\tdraft\t${contract.sourceNodeId}->${contract.targetNodeId}\tversion=1`
  );
}

function runCheckpointCommand(
  options: ParsedOptions,
  workspaceId: string,
  context: CompassoCliContext
): void {
  const [operation, second, third, ...extra] = options.positional;
  if (operation === "list") {
    if (
      third !== undefined ||
      extra.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      options.task !== null ||
      options.contract !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options) ||
      hasArtifactMemoryOptions(options) ||
      hasContractOptions(options)
    ) {
      throw new Error("Usage: compasso checkpoint list [agent] [--workspace <id|name>] [--json]");
    }
    const agentNodeId =
      second === undefined
        ? null
        : resolveAgent(context.store.listAgents(workspaceId), second).nodeId;
    const checkpoints = context.store.listExecutionCheckpoints(workspaceId, agentNodeId, 50);
    context.write(
      options.json
        ? JSON.stringify(checkpoints, null, 2)
        : checkpoints
            .map(
              (checkpoint) =>
                `${checkpoint.id}\t${checkpoint.type}\t${checkpoint.agentNodeId}\t${checkpoint.snapshot.sha256}`
            )
            .join("\n")
    );
    return;
  }

  if (operation === "show") {
    if (
      second === undefined ||
      third !== undefined ||
      extra.length > 0 ||
      options.idempotencyKey !== null ||
      options.batch !== null ||
      options.from !== null ||
      options.task !== null ||
      options.contract !== null ||
      hasSpawnOptions(options) ||
      hasNoteOptions(options) ||
      hasArtifactOptions(options) ||
      hasHandoffOptions(options) ||
      hasArtifactMemoryOptions(options) ||
      hasContractOptions(options)
    ) {
      throw new Error(
        "Usage: compasso checkpoint show <checkpoint-id> [--workspace <id|name>] [--json]"
      );
    }
    const checkpoint = context.store.getExecutionCheckpoint(workspaceId, second);
    context.write(
      options.json
        ? JSON.stringify(checkpoint, null, 2)
        : `${checkpoint.id}\t${checkpoint.type}\t${checkpoint.snapshot.sha256}`
    );
    return;
  }

  if (
    operation !== "create" ||
    second === undefined ||
    third === undefined ||
    extra.length > 0 ||
    options.task === null ||
    options.idempotencyKey !== null ||
    options.batch !== null ||
    options.from !== null ||
    hasSpawnOptions(options) ||
    hasNoteOptions(options) ||
    hasArtifactOptions(options) ||
    hasHandoffOptions(options) ||
    hasArtifactMemoryOptions(options) ||
    hasContractCreateOptions(options)
  ) {
    throw new Error(
      'Usage: compasso checkpoint create <function|delivery> <agent> --task "<task>" [--contract <contract-id>] [--workspace <id|name>] [--json]'
    );
  }
  const type = parseCheckpointType(second);
  const agent = resolveAgent(context.store.listAgents(workspaceId), third);
  const checkpoint = context.store.checkpointExecutionContext({
    workspaceId,
    agentNodeId: agent.nodeId,
    type,
    task: options.task,
    contractId: options.contract
  });
  context.write(
    options.json
      ? JSON.stringify(checkpoint, null, 2)
      : `${checkpoint.id}\t${checkpoint.type}\t${checkpoint.snapshot.sha256}`
  );
}

/**
 * The autonomous-mode entry point is deliberately proposal-only. It does not enqueue a run,
 * allocate a worktree, or derive additional permissions. A separately reviewed action may later
 * select a known workflow template through the existing runtime commands.
 */
function runProposalCommand(
  options: ParsedOptions,
  workspaceId: string,
  context: CompassoCliContext
): void {
  const [operation, reference, objective, ...extra] = options.positional;
  if (hasInvalidProposalOptions(options)) throw new Error(proposalUsage());
  if (
    (options.revision !== null &&
      operation !== "revise" &&
      operation !== "approve" &&
      operation !== "reject") ||
    (options.summary !== null && operation !== "create" && operation !== "revise")
  ) {
    throw new Error(proposalUsage());
  }

  if (operation === "list" && reference === undefined) {
    const proposals = context.store.listOrchestrationProposals(workspaceId, 50);
    context.write(
      options.json
        ? JSON.stringify(proposals, null, 2)
        : proposals
            .map(
              (proposal) =>
                `${proposal.id}\t${proposal.status}\t${proposal.autonomyLevel}\trevision=${proposal.revision}\t${proposal.objective}`
            )
            .join("\n")
    );
    return;
  }

  if (
    (operation === "show" || operation === "events") &&
    reference !== undefined &&
    objective === undefined
  ) {
    if (operation === "show") {
      const proposal = context.store.getOrchestrationProposal(workspaceId, reference);
      context.write(
        options.json
          ? JSON.stringify(proposal, null, 2)
          : [
              proposal.id,
              `status=${proposal.status}`,
              `revision=${proposal.revision}`,
              `autonomy=${proposal.autonomyLevel}`,
              `objective=${proposal.objective}`,
              `workflow=${proposal.workflowTemplateId ?? "pending human selection"}`
            ].join("\n")
      );
      return;
    }
    const events = context.store.listOrchestrationProposalEvents(workspaceId, reference);
    context.write(
      options.json
        ? JSON.stringify(events, null, 2)
        : events
            .map((event) => `${event.sequence}\t${event.type}\t${event.actor}\t${event.createdAt}`)
            .join("\n")
    );
    return;
  }

  if (
    operation === "create" &&
    reference !== undefined &&
    objective === undefined &&
    extra.length === 0
  ) {
    const agents = context.store.listAgents(workspaceId);
    const proposal = context.store.createOrchestrationProposal({
      workspaceId,
      objective: reference,
      understanding:
        options.summary ??
        "The objective was recorded for local human review; no execution is authorized yet.",
      questions: ["Which existing workflow template should the human reviewer select?"],
      requiredMaterials: ["Current workspace canvas and directly connected context"],
      suggestedTeam: agents.map((agent) => ({
        nodeId: agent.nodeId,
        role: agent.roleName ?? agent.name
      })),
      workflowTemplateId: null,
      executionAgentNodeId: null,
      dependencies: [],
      requestedPermissions: [],
      gates: ["human_approval"],
      risks: ["The proposed workflow and any permissions remain unset until human review."],
      estimatedCost: null,
      estimatedDuration: null,
      autonomyLevel: "assisted",
      autonomy: defaultAutonomyConfig
    });
    writeProposal(context, proposal, options.json);
    return;
  }

  if (
    operation === "revise" &&
    reference !== undefined &&
    objective !== undefined &&
    extra.length === 0 &&
    options.revision !== null
  ) {
    const current = context.store.getOrchestrationProposal(workspaceId, reference);
    const proposal = context.store.updateOrchestrationProposal({
      workspaceId,
      proposalId: reference,
      expectedRevision: options.revision,
      draft: proposalDraft({
        ...current,
        objective,
        understanding: options.summary ?? current.understanding
      })
    });
    writeProposal(context, proposal, options.json);
    return;
  }

  if (
    (operation === "approve" || operation === "reject") &&
    reference !== undefined &&
    objective === undefined &&
    options.revision !== null
  ) {
    const proposal =
      operation === "approve"
        ? context.store.approveOrchestrationProposal({
            workspaceId,
            proposalId: reference,
            expectedRevision: options.revision
          })
        : context.store.rejectOrchestrationProposal({
            workspaceId,
            proposalId: reference,
            expectedRevision: options.revision
          });
    writeProposal(context, proposal, options.json);
    return;
  }

  throw new Error(proposalUsage());
}

function hasInvalidProposalOptions(options: ParsedOptions): boolean {
  return (
    options.idempotencyKey !== null ||
    options.batch !== null ||
    options.from !== null ||
    options.agent !== null ||
    options.role !== null ||
    options.name !== null ||
    options.alternativeLabel !== null ||
    hasNoteOptions(options) ||
    hasArtifactOptions(options) ||
    options.artifact !== null ||
    options.connectionType !== null ||
    options.connectionLabel !== null ||
    options.state !== null ||
    options.since !== null ||
    options.until !== null ||
    options.limit !== null ||
    hasGovernanceOptions(options) ||
    hasArtifactMemoryOptions(options) ||
    hasContractOptions(options) ||
    options.dryRun
  );
}

function proposalDraft(proposal: OrchestrationProposal) {
  return {
    workspaceId: proposal.workspaceId,
    objective: proposal.objective,
    understanding: proposal.understanding,
    questions: proposal.questions,
    requiredMaterials: proposal.requiredMaterials,
    suggestedTeam: proposal.suggestedTeam,
    workflowTemplateId: proposal.workflowTemplateId,
    executionAgentNodeId: proposal.executionAgentNodeId,
    dependencies: proposal.dependencies,
    requestedPermissions: proposal.requestedPermissions,
    gates: proposal.gates,
    risks: proposal.risks,
    estimatedCost: proposal.estimatedCost,
    estimatedDuration: proposal.estimatedDuration,
    autonomyLevel: proposal.autonomyLevel,
    autonomy: proposal.autonomy
  };
}

function writeProposal(
  context: CompassoCliContext,
  proposal: OrchestrationProposal,
  json: boolean
): void {
  context.write(
    json
      ? JSON.stringify(proposal, null, 2)
      : `${proposal.id}\t${proposal.status}\trevision=${proposal.revision}\t${proposal.checksum}`
  );
}

function proposalUsage(): string {
  return 'Usage: compasso proposal <create|list|show|events|revise|approve|reject> [proposal-id|"objective"] ["revised objective"] [--summary <understanding>] [--revision <n>] [--workspace <id|name>] [--json]';
}

function runWorkflowRunCommand(
  options: ParsedOptions,
  workspaceId: string,
  context: CompassoCliContext
): void {
  const [operation, runId, nodeId, ...extra] = options.positional;
  if (hasInvalidRunOptions(options, operation)) throw new Error(runUsage());
  if (options.dryRun && operation !== "start") throw new Error(runUsage());
  if (options.summary !== null && operation !== "approve" && operation !== "reject") {
    throw new Error(runUsage());
  }
  if (operation === "list" && runId === undefined && nodeId === undefined && extra.length === 0) {
    const runs = context.store.listWorkflowRuns({ limit: 50 });
    context.write(
      options.json
        ? JSON.stringify(runs, null, 2)
        : runs
            .map(
              (run) =>
                `${run.id}\t${run.workflowId}\t${run.state}\tnodes=${run.nodeRuns.length}\t${run.startedAt ?? "queued"}`
            )
            .join("\n")
    );
    return;
  }
  if (
    operation === "alternatives" &&
    runId !== undefined &&
    nodeId !== undefined &&
    extra.length === 0 &&
    options.alternativeLabel === null
  ) {
    const runs = context.store.listWorkflowRunAlternatives(runId, nodeId);
    context.write(
      options.json
        ? JSON.stringify(runs, null, 2)
        : runs
            .map((run) => `${run.id}\t${run.state}\t${run.lineage?.alternativeLabel ?? "unnamed"}`)
            .join("\n")
    );
    return;
  }
  if (
    (operation === "show" || operation === "events") &&
    runId !== undefined &&
    nodeId === undefined &&
    extra.length === 0
  ) {
    if (operation === "show") {
      const run = context.store.getWorkflowRun(runId);
      if (run === null) throw new Error(`Workflow run not found: ${runId}`);
      context.write(
        options.json
          ? JSON.stringify(run, null, 2)
          : `${run.id}\t${run.workflowId}\t${run.state}\tnodes=${run.nodeRuns.length}`
      );
      return;
    }
    const events = context.store.listWorkflowRunEvents(runId, 500);
    context.write(
      options.json
        ? JSON.stringify(events, null, 2)
        : events.map((event) => `${event.sequence}\t${event.type}\t${event.timestamp}`).join("\n")
    );
    return;
  }
  if (operation === "start" && runId !== undefined && nodeId === undefined && extra.length === 0) {
    if (options.agent === null || options.task === null) throw new Error(runUsage());
    const agentNodeId = resolveAgent(context.store.listAgents(workspaceId), options.agent).nodeId;
    writeWorkflowRunCommand(
      context,
      context.store.requestWorkflowRunStart({
        templateId: runId,
        workspaceId,
        dryRun: options.dryRun,
        agentNodeId,
        task: options.task,
        ...(options.contract === null ? {} : { contractId: options.contract }),
        contextMode: options.contextMode ?? "full"
      }),
      options.json
    );
    return;
  }
  if (
    (operation === "pause" || operation === "resume" || operation === "cancel") &&
    runId !== undefined &&
    nodeId === undefined &&
    extra.length === 0 &&
    options.rerunScope === null
  ) {
    writeWorkflowRunCommand(
      context,
      context.store.requestWorkflowRunControl({ action: operation, runId }),
      options.json
    );
    return;
  }
  if (
    operation === "retry" &&
    runId !== undefined &&
    extra.length === 0 &&
    !(nodeId === undefined && options.rerunScope !== null)
  ) {
    const retryScope =
      nodeId === undefined ? undefined : parseWorkflowRetryScope(options.rerunScope ?? "node");
    writeWorkflowRunCommand(
      context,
      context.store.requestWorkflowRunControl({
        action: "retry",
        runId,
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(retryScope === undefined ? {} : { retryScope })
      }),
      options.json
    );
    return;
  }
  if (
    operation === "alternative" &&
    runId !== undefined &&
    nodeId !== undefined &&
    extra.length === 0 &&
    options.rerunScope === null
  ) {
    writeWorkflowRunCommand(
      context,
      context.store.requestWorkflowRunControl({
        action: "alternative",
        runId,
        nodeId,
        ...(options.alternativeLabel === null ? {} : { alternativeLabel: options.alternativeLabel })
      }),
      options.json
    );
    return;
  }
  if (
    (operation === "approve" || operation === "reject") &&
    runId !== undefined &&
    nodeId !== undefined &&
    extra.length === 0
  ) {
    writeWorkflowRunCommand(
      context,
      context.store.requestWorkflowRunControl({
        action: operation,
        runId,
        nodeId,
        ...(options.summary === null ? {} : { decisionNote: options.summary })
      }),
      options.json
    );
    return;
  }
  throw new Error(runUsage());
}

function hasInvalidRunOptions(options: ParsedOptions, operation: string | undefined): boolean {
  return (
    options.idempotencyKey !== null ||
    options.batch !== null ||
    options.from !== null ||
    options.connectionType !== null ||
    options.connectionLabel !== null ||
    options.revision !== null ||
    options.state !== null ||
    options.since !== null ||
    options.until !== null ||
    options.limit !== null ||
    options.role !== null ||
    options.name !== null ||
    (options.rerunScope !== null && operation !== "retry") ||
    (options.alternativeLabel !== null && operation !== "alternative") ||
    (options.contextMode !== null && operation !== "start") ||
    (options.agent !== null && operation !== "start") ||
    ((options.task !== null || options.contract !== null) && operation !== "start") ||
    hasNoteOptions(options) ||
    hasArtifactOptions(options) ||
    hasArtifactMemoryOptions(options) ||
    hasContractCreateOptions(options)
  );
}

function writeWorkflowRunCommand(
  context: CompassoCliContext,
  command: ReturnType<AgentCliStore["requestWorkflowRunStart"]>,
  json: boolean
): void {
  context.write(
    json
      ? JSON.stringify(command, null, 2)
      : `${command.id}\t${command.action}\tqueued\t${command.createdAt}`
  );
}

function runUsage(): string {
  return "Usage: compasso run <list|show|events|start|pause|resume|cancel|retry|alternative|alternatives|approve|reject> [run-id|template-id] [node-id] [--rerun-scope <node|dependents>] [--alternative-label <label>] [--agent <id|name>] [--task <task>] [--contract <contract-id>] [--context-mode <full|intelligent|economical>] [--dry-run] [--summary <note>] [--json]";
}

function runRuntimeCommand(options: ParsedOptions, context: CompassoCliContext): void {
  const [operation, extra] = options.positional;
  if (
    operation === undefined ||
    extra !== undefined ||
    options.idempotencyKey !== null ||
    options.batch !== null ||
    options.from !== null ||
    hasSpawnOptions(options) ||
    hasNoteOptions(options) ||
    hasArtifactOptions(options) ||
    hasHandoffOptions(options) ||
    options.connectionType !== null ||
    options.connectionLabel !== null ||
    options.revision !== null ||
    options.state !== null ||
    options.since !== null ||
    options.until !== null ||
    options.limit !== null
  ) {
    throw new Error(
      "Usage: compasso runtime <status|start|pause|resume|drain|cancel|shutdown> [--json]"
    );
  }
  if (operation === "status") {
    const status = context.store.getRuntimeLifecycleStatus();
    context.write(
      options.json
        ? JSON.stringify(status, null, 2)
        : `${status.state}\trevision=${status.revision}\tupdated=${status.updatedAt}`
    );
    return;
  }
  if (!isRuntimeLifecycleAction(operation)) {
    throw new Error(
      "Usage: compasso runtime <status|start|pause|resume|drain|cancel|shutdown> [--json]"
    );
  }
  const command = context.store.requestRuntimeLifecycle(operation);
  context.write(
    options.json
      ? JSON.stringify(command, null, 2)
      : `${command.id}\t${command.action}\tqueued\t${command.createdAt}`
  );
}

function isRuntimeLifecycleAction(
  value: string
): value is Parameters<AgentCliStore["requestRuntimeLifecycle"]>[0] {
  return ["start", "pause", "resume", "drain", "cancel", "shutdown"].includes(value);
}

function parseOptions(args: readonly string[], command: string): ParsedOptions {
  const positional: string[] = [];
  let workspace: string | null = null;
  let idempotencyKey: string | null = null;
  let batch: string | null = null;
  let from: string | null = null;
  let agent: string | null = null;
  let role: string | null = null;
  let name: string | null = null;
  let title: string | null = null;
  let content: string | null = null;
  let kind: string | null = null;
  let summary: string | null = null;
  let artifact: string | null = null;
  let connectionType: string | null = null;
  let connectionLabel: string | null = null;
  let revision: number | null = null;
  let state: string | null = null;
  let since: string | null = null;
  let until: string | null = null;
  let limit: number | null = null;
  let scope: string | null = null;
  let decisions: string | null = null;
  let constraints: string | null = null;
  let progress: string | null = null;
  let blockers: string | null = null;
  let stack: string | null = null;
  let architecture: string | null = null;
  let patterns: string | null = null;
  let commands: string | null = null;
  let conventions: string | null = null;
  let technicalDecisions: string | null = null;
  let relationships: string | null = null;
  let relevance: string | null = null;
  let artifactStatus: string | null = null;
  let inputs: string | null = null;
  let outputs: string | null = null;
  let criteria: string | null = null;
  let evidence: string | null = null;
  let maxAttempts: number | null = null;
  let maxContextBytes: number | null = null;
  let task: string | null = null;
  let contract: string | null = null;
  let rerunScope: string | null = null;
  let alternativeLabel: string | null = null;
  let contextMode: ContextSelectionMode | null = null;
  let roleConstraints: string | null = null;
  let roleDeliverable: string | null = null;
  let roleCriteria: string | null = null;
  let dryRun = false;
  let wait = false;
  let timeoutSeconds: number | null = null;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) break;
    if (value === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (value === "--wait") {
      wait = true;
      continue;
    }
    if (
      value === "--workspace" ||
      value === "--idempotency-key" ||
      value === "--batch" ||
      value === "--from" ||
      value === "--agent" ||
      value === "--role" ||
      value === "--name" ||
      value === "--title" ||
      value === "--content" ||
      value === "--kind" ||
      value === "--summary" ||
      value === "--artifact" ||
      value === "--type" ||
      value === "--label" ||
      value === "--revision" ||
      value === "--state" ||
      value === "--since" ||
      value === "--until" ||
      value === "--limit" ||
      value === "--scope" ||
      value === "--decisions" ||
      value === "--constraints" ||
      value === "--progress" ||
      value === "--blockers" ||
      value === "--stack" ||
      value === "--architecture" ||
      value === "--patterns" ||
      value === "--commands" ||
      value === "--conventions" ||
      value === "--technical-decisions" ||
      value === "--relationships" ||
      value === "--relevance" ||
      value === "--artifact-status" ||
      value === "--inputs" ||
      value === "--outputs" ||
      value === "--criteria" ||
      value === "--evidence" ||
      value === "--max-attempts" ||
      value === "--max-context-bytes" ||
      value === "--task" ||
      value === "--contract" ||
      value === "--rerun-scope" ||
      value === "--alternative-label" ||
      value === "--timeout" ||
      value === "--role-constraints" ||
      value === "--role-deliverable" ||
      value === "--role-criteria" ||
      value === "--context-mode"
    ) {
      const optionValue = args[index + 1];
      if (optionValue === undefined || optionValue.startsWith("--")) {
        throw new Error(`${value} requires a value`);
      }
      if (value === "--workspace") workspace = optionValue;
      else if (value === "--idempotency-key") idempotencyKey = optionValue;
      else if (value === "--batch") batch = optionValue;
      else if (value === "--from") from = optionValue;
      else if (value === "--agent") agent = optionValue;
      else if (value === "--role") role = optionValue;
      else if (value === "--name") name = optionValue;
      else if (value === "--title") title = optionValue;
      else if (value === "--content") content = optionValue;
      else if (value === "--kind") kind = optionValue;
      else if (value === "--summary") summary = optionValue;
      else if (value === "--artifact") artifact = optionValue;
      else if (value === "--type") connectionType = optionValue;
      else if (value === "--label") connectionLabel = optionValue;
      else if (value === "--state") state = optionValue;
      else if (value === "--since") since = optionValue;
      else if (value === "--until") until = optionValue;
      else if (value === "--scope") scope = optionValue;
      else if (value === "--decisions") decisions = optionValue;
      else if (value === "--constraints") constraints = optionValue;
      else if (value === "--progress") progress = optionValue;
      else if (value === "--blockers") blockers = optionValue;
      else if (value === "--stack") stack = optionValue;
      else if (value === "--architecture") architecture = optionValue;
      else if (value === "--patterns") patterns = optionValue;
      else if (value === "--commands") commands = optionValue;
      else if (value === "--conventions") conventions = optionValue;
      else if (value === "--technical-decisions") technicalDecisions = optionValue;
      else if (value === "--relationships") relationships = optionValue;
      else if (value === "--relevance") relevance = optionValue;
      else if (value === "--artifact-status") artifactStatus = optionValue;
      else if (value === "--inputs") inputs = optionValue;
      else if (value === "--outputs") outputs = optionValue;
      else if (value === "--criteria") criteria = optionValue;
      else if (value === "--evidence") evidence = optionValue;
      else if (value === "--task") task = optionValue;
      else if (value === "--contract") contract = optionValue;
      else if (value === "--rerun-scope") rerunScope = optionValue;
      else if (value === "--alternative-label") alternativeLabel = optionValue;
      else if (value === "--role-constraints") roleConstraints = optionValue;
      else if (value === "--role-deliverable") roleDeliverable = optionValue;
      else if (value === "--role-criteria") roleCriteria = optionValue;
      else if (value === "--context-mode")
        contextMode = contextSelectionModeSchema.parse(optionValue);
      else if (value === "--timeout") {
        if (!/^\d+$/.test(optionValue)) throw new Error("--timeout must be a positive integer");
        timeoutSeconds = Number(optionValue);
        if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
          throw new Error("--timeout must be between 1 and 3600 seconds");
        }
      } else if (value === "--limit") {
        if (!/^\d+$/.test(optionValue)) throw new Error("--limit must be a positive integer");
        limit = Number(optionValue);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
          throw new Error("--limit must be between 1 and 500");
        }
      } else if (value === "--max-attempts") {
        if (!/^\d+$/.test(optionValue)) throw new Error("--max-attempts must be an integer");
        maxAttempts = Number(optionValue);
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
          throw new Error("--max-attempts must be between 1 and 10");
        }
      } else if (value === "--max-context-bytes") {
        if (!/^\d+$/.test(optionValue)) {
          throw new Error("--max-context-bytes must be an integer");
        }
        maxContextBytes = Number(optionValue);
        if (
          !Number.isSafeInteger(maxContextBytes) ||
          maxContextBytes < 4 * 1024 ||
          maxContextBytes > 2 * 1024 * 1024
        ) {
          throw new Error("--max-context-bytes must be between 4096 and 2097152");
        }
      } else {
        if (!/^\d+$/.test(optionValue)) {
          throw new Error("--revision must be a non-negative integer");
        }
        revision = Number(optionValue);
        if (!Number.isSafeInteger(revision)) {
          throw new Error("--revision must be a non-negative integer");
        }
      }
      index += 1;
    } else if (value === "--json") {
      json = true;
    } else if (value.startsWith("--")) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      positional.push(value);
    }
  }
  if (command !== "connect" && command !== "history" && connectionType !== null) {
    throw new Error("--type is only supported by compasso connect and history");
  }
  if (command !== "connect" && connectionLabel !== null) {
    throw new Error("--label is only supported by compasso connect");
  }
  if (
    command !== "connect" &&
    command !== "handoff" &&
    command !== "history" &&
    command !== "proposal" &&
    revision !== null
  ) {
    throw new Error("--revision is only supported by compasso connect, handoff and proposal");
  }
  if (command !== "history" && (state !== null || since !== null || until !== null)) {
    throw new Error("--state, --since and --until are only supported by compasso history");
  }
  if (command !== "history" && command !== "autonomy" && limit !== null) {
    throw new Error("--limit is only supported by compasso history and autonomy");
  }
  if (
    command !== "mission" &&
    hasMissionOptions({ scope, decisions, constraints, progress, blockers })
  ) {
    throw new Error("Mission options are only supported by compasso mission");
  }
  if (
    command !== "memory" &&
    hasMemoryOptions({ stack, architecture, patterns, commands, conventions, technicalDecisions })
  ) {
    throw new Error("Memory options are only supported by compasso memory");
  }
  if (
    command !== "artifact" &&
    hasArtifactMemoryOptions({ relationships, relevance, artifactStatus })
  ) {
    throw new Error("Artifact memory options are only supported by compasso artifact memory");
  }
  if (
    command !== "contract" &&
    hasContractCreateOptions({ inputs, outputs, criteria, evidence, maxAttempts, maxContextBytes })
  ) {
    throw new Error("Contract options are only supported by compasso contract");
  }
  if (
    command !== "context" &&
    command !== "checkpoint" &&
    command !== "run" &&
    (task !== null || contract !== null)
  ) {
    throw new Error(
      "--task and --contract are only supported by compasso context, checkpoint and run start"
    );
  }
  if (command !== "run" && dryRun) {
    throw new Error("--dry-run is only supported by compasso run start");
  }
  if (command !== "run" && rerunScope !== null) {
    throw new Error("--rerun-scope is only supported by compasso run retry");
  }
  if (command !== "run" && alternativeLabel !== null) {
    throw new Error("--alternative-label is only supported by compasso run alternative");
  }
  if (command !== "context" && command !== "run" && contextMode !== null) {
    throw new Error("--context-mode is only supported by compasso context build and run start");
  }
  return {
    positional,
    workspace,
    idempotencyKey,
    batch,
    from,
    agent,
    role,
    name,
    title,
    content,
    kind,
    summary,
    artifact,
    connectionType,
    connectionLabel,
    revision,
    state,
    since,
    until,
    limit,
    scope,
    decisions,
    constraints,
    progress,
    blockers,
    stack,
    architecture,
    patterns,
    commands,
    conventions,
    technicalDecisions,
    relationships,
    relevance,
    artifactStatus,
    inputs,
    outputs,
    criteria,
    evidence,
    maxAttempts,
    maxContextBytes,
    task,
    contract,
    rerunScope,
    alternativeLabel,
    contextMode,
    roleConstraints,
    roleDeliverable,
    roleCriteria,
    dryRun,
    wait,
    timeoutSeconds,
    json
  };
}

function hasSpawnOptions(options: ParsedOptions): boolean {
  return options.agent !== null || options.role !== null || options.name !== null;
}

function hasNoteOptions(options: ParsedOptions): boolean {
  return options.title !== null || options.content !== null;
}

function hasArtifactOptions(options: ParsedOptions): boolean {
  return options.kind !== null;
}

function hasHandoffOptions(options: ParsedOptions): boolean {
  return options.summary !== null || options.artifact !== null;
}

function hasMissionOptions(
  options: Pick<ParsedOptions, "scope" | "decisions" | "constraints" | "progress" | "blockers">
): boolean {
  return (
    options.scope !== null ||
    options.decisions !== null ||
    options.constraints !== null ||
    options.progress !== null ||
    options.blockers !== null
  );
}

function hasMemoryOptions(
  options: Pick<
    ParsedOptions,
    "stack" | "architecture" | "patterns" | "commands" | "conventions" | "technicalDecisions"
  >
): boolean {
  return (
    options.stack !== null ||
    options.architecture !== null ||
    options.patterns !== null ||
    options.commands !== null ||
    options.conventions !== null ||
    options.technicalDecisions !== null
  );
}

function hasGovernanceOptions(options: ParsedOptions): boolean {
  return hasMissionOptions(options) || hasMemoryOptions(options);
}

function hasArtifactMemoryOptions(
  options: Pick<ParsedOptions, "relationships" | "relevance" | "artifactStatus">
): boolean {
  return (
    options.relationships !== null || options.relevance !== null || options.artifactStatus !== null
  );
}

function hasContractCreateOptions(
  options: Pick<
    ParsedOptions,
    "inputs" | "outputs" | "criteria" | "evidence" | "maxAttempts" | "maxContextBytes"
  >
): boolean {
  return (
    options.inputs !== null ||
    options.outputs !== null ||
    options.criteria !== null ||
    options.evidence !== null ||
    options.maxAttempts !== null ||
    options.maxContextBytes !== null
  );
}

function hasContractOptions(options: ParsedOptions): boolean {
  return hasContractCreateOptions(options) || options.task !== null || options.contract !== null;
}

function parseList(value: string | null): string[] {
  if (value === null || value.trim().length === 0) return [];
  return value.split(",").map((item) => item.trim());
}

function parseArtifactRelationships(value: string | null): ArtifactMemoryRelation[] {
  if (value === null || value.trim().length === 0) return [];
  return value.split(",").map((item) => {
    const separator = item.indexOf(":");
    if (separator < 1 || separator === item.length - 1) {
      throw new Error("Artifact relationships must use artifact-id:kind");
    }
    return {
      artifactId: item.slice(0, separator).trim(),
      kind: item.slice(separator + 1).trim() as ArtifactMemoryRelation["kind"]
    };
  });
}

function parseArtifactMemoryVersion(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("Artifact memory version must be a positive integer");
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Artifact memory version must be a positive integer");
  }
  return version;
}

function parseWorkflowRetryScope(value: string): "node" | "dependents" {
  if (value === "node" || value === "dependents") return value;
  throw new Error("Workflow retry scope must be node or dependents");
}

function formatArtifactMemoryChange(
  change: { readonly from: string; readonly to: string } | null
): string {
  return change === null ? "unchanged" : `${change.from}->${change.to}`;
}

function toPublicArtifactMemory(memory: ArtifactMemory) {
  return artifactMemoryViewSchema.parse({
    id: memory.id,
    workspaceId: memory.workspaceId,
    artifactId: memory.artifactId,
    version: memory.version,
    sha256: memory.sha256,
    relationships: memory.relationships,
    relevance: memory.relevance,
    status: memory.status,
    restoredFromVersion: memory.restoredFromVersion,
    createdBy: memory.createdBy,
    createdAt: memory.createdAt
  });
}

function parseDeliveryEvidence(value: string | null): DeliveryEvidence[] {
  if (value === null || value.trim().length === 0) return [];
  return value.split(",").map((item) => {
    const separator = item.indexOf(":");
    if (separator < 1 || separator === item.length - 1) {
      throw new Error("Evidence must use kind:reference");
    }
    return {
      kind: item.slice(0, separator).trim() as DeliveryEvidence["kind"],
      reference: item.slice(separator + 1).trim()
    };
  });
}

function parseCheckpointType(value: string): ExecutionCheckpointType {
  if (value === "function" || value === "delivery") return value;
  throw new Error("Checkpoint type must be function or delivery");
}

function resolveSpawnAdapter(value: string): AgentSpawnAdapterId {
  if (equalsFold(value, "codex")) return "codex";
  if (equalsFold(value, "claude") || equalsFold(value, "claude-code")) return "claude-code";
  throw new Error(`Unsupported spawn agent: ${value}`);
}

function selectWorkspace(
  workspaces: readonly AgentWorkspace[],
  cwd: string,
  requested: string | null
): AgentWorkspace {
  if (requested !== null) {
    const matches = workspaces.filter(
      (workspace) => workspace.id === requested || equalsFold(workspace.title, requested)
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Workspace not found: ${requested}`
          : `Workspace name is ambiguous: ${requested}`
      );
    }
    return requireFirst(matches);
  }
  const current = resolve(cwd);
  const matches = workspaces.filter((workspace) => containsPath(workspace.projectRoot, current));
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "Current directory is not associated with a Compasso workspace; use --workspace"
        : "Project has multiple Compasso workspaces; use --workspace"
    );
  }
  return requireFirst(matches);
}

/**
 * Blocks until the recipient answers the message this call just enqueued, so an agent can ask
 * another agent for work and read the reply in its own stdout — no human copying text between
 * terminals.
 *
 * Three things make this honest rather than a hopeful sleep:
 *
 *  - it waits for a *correlated response*, not for the recipient's terminal to fall silent. Idle is
 *    not an answer, exactly as a run's structured result — never idle — completes a task;
 *  - a delivery that fails stops the wait immediately with the recorded reason, instead of burning
 *    the whole timeout on a message that will never arrive;
 *  - the timeout is finite and its expiry is reported as "still waiting", never as an empty answer.
 *
 * The CLI is a short-lived process reading the same SQLite the desktop writes, so polling is the
 * mechanism; blocking this thread costs nothing because it has nothing else to do.
 */
function awaitAgentResponse(
  context: CompassoCliContext,
  workspaceId: string,
  messageId: string,
  recipientNodeId: string,
  options: ParsedOptions
): number {
  const clock = context.clock ?? systemClock;
  const timeoutMs = (options.timeoutSeconds ?? DEFAULT_ASK_WAIT_SECONDS) * 1000;
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const [response] = context.store.listResponses(workspaceId, messageId, 1);
    if (response !== undefined) {
      context.write(`${response.responderNodeId}\t${response.status}`);
      context.write(response.content);
      return 0;
    }
    const request = context.store.getMessage(messageId);
    if (request !== null && request.status === "failed") {
      throw new Error(
        `Message to ${recipientNodeId} was not delivered: ${request.errorCode ?? "unknown_error"}`
      );
    }
    if (request !== null && request.status === "cancelled") {
      throw new Error(`Message to ${recipientNodeId} was cancelled before it was answered`);
    }
    if (clock.now() >= deadline) {
      throw new Error(
        `No response from ${recipientNodeId} within ${String(timeoutMs / 1000)}s. ` +
          `The request is still recorded; check it with: compasso responses ${messageId}`
      );
    }
    clock.sleep(Math.min(ASK_WAIT_POLL_INTERVAL_MS, Math.max(1, deadline - clock.now())));
  }
}

/**
 * A blocking sleep, deliberately. `runCompassoCli` is synchronous and a waiting CLI has no other
 * work to interleave, so parking the thread is simpler and more predictable than making the whole
 * command surface async.
 */
const systemClock: NonNullable<CompassoCliContext["clock"]> = {
  now: () => Date.now(),
  sleep: (milliseconds) => {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, milliseconds);
  }
};

/**
 * Who the caller is. An explicit `--from` always wins; otherwise the identity the desktop injected
 * into this terminal is used. Only `list` reads it for now: every other command keeps its current
 * meaning, where no `--from` means the person operating the app, not the agent in the terminal.
 */
function resolveSelfReference(options: ParsedOptions, context: CompassoCliContext): string {
  const self = options.from ?? context.env?.[COMPAZIO_TERMINAL_ID_ENV] ?? null;
  if (self === null) {
    throw new Error(
      "This terminal has no Compazio identity; run it from an agent terminal or pass --from <agent>"
    );
  }
  return self;
}

function resolveNodeTitle(
  context: CompassoCliContext,
  workspaceId: string,
  nodeId: string
): string {
  try {
    return context.store.resolveConnectionNode(workspaceId, nodeId).title;
  } catch {
    // A node removed from the canvas but still referenced by a stored connection stays legible.
    return "(nó indisponível)";
  }
}

function resolveAgent(agents: readonly AgentDirectoryEntry[], target: string): AgentDirectoryEntry {
  const matches = agents.filter(
    (agent) =>
      agent.nodeId === target ||
      equalsFold(agent.name, target) ||
      (agent.roleName !== null && equalsFold(agent.roleName, target))
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0 ? `Agent not found: ${target}` : `Agent target is ambiguous: ${target}`
    );
  }
  return requireFirst(matches);
}

function resolveBatchAgents(
  agents: readonly AgentDirectoryEntry[],
  value: string
): readonly AgentDirectoryEntry[] {
  const targets = value
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
  if (targets.length < 1 || targets.length > 32) {
    throw new Error("Batch must contain between 1 and 32 agent targets");
  }
  const resolved = targets.map((target) => resolveAgent(agents, target));
  if (new Set(resolved.map((agent) => agent.nodeId)).size !== resolved.length) {
    throw new Error("Batch agent targets must be unique");
  }
  return resolved;
}

function toPublicContext(agentContext: WorkspaceAgentContext): unknown {
  return {
    ...agentContext,
    sources: agentContext.sources.map((source) => {
      if (source.artifact === undefined) return source;
      const artifact = {
        id: source.artifact.id,
        kind: source.artifact.kind,
        filename: source.artifact.filename,
        sha256: source.artifact.sha256,
        byteSize: source.artifact.byteSize,
        mediaType: source.artifact.mediaType
      };
      return { ...source, artifact };
    })
  };
}

function batchIdempotencyKey(base: string, nodeId: string): string {
  const candidate = `${base}:${nodeId}`;
  if (candidate.length <= 200) return candidate;
  return `batch:${createHash("sha256").update(candidate).digest("hex")}`;
}

function requireFirst<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected one resolved CLI target");
  return value;
}

function containsPath(parent: string, candidate: string): boolean {
  const child = relative(resolve(parent), candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function equalsFold(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function helpText(): string {
  return [
    "Compasso CLI",
    "",
    "  compasso list [--from <agent>] [--workspace <id|name>] [--json]",
    "  compasso agents [--workspace <id|name>] [--json]",
    "  compasso note read <note> [--workspace <id|name>]",
    '  compasso note write <note> "<content>" [--from <agent>]',
    "  compasso agent status [<agent>] [--workspace <id|name>] [--json]",
    "  compasso terminal create --agent <claude-code|codex> --role <role> --name <name> [--from <agent>]",
    "  compasso terminal remove <agent> [--from <agent>]",
    "  compasso terminal restart <agent> [--from <agent>]",
    '  compasso terminal assign-role <agent> --role <name> --content "<responsabilidades>" [--role-constraints <t>] [--role-deliverable <t>] [--role-criteria <t>] [--from <agent>]',
    "  compasso terminal list [--limit <n>] [--workspace <id|name>] [--json]",
    '  compasso ask <agent> "<message>" [--from <agent>] [--wait [--timeout <seconds>]] [--idempotency-key <key>]',
    '  compasso ask --batch <agent,agent> "<message>" [--from <agent>]',
    "  compasso status [--workspace <id|name>] [--json]",
    "  compasso runtime <status|start|pause|resume|drain|cancel|shutdown> [--workspace <id|name>] [--json]",
    "  compasso autonomy <status|kill|release|decisions> [--limit <n>] [--workspace <id|name>] [--json]",
    "  compasso run <list|show|events> [run-id] [--workspace <id|name>] [--json]",
    '  compasso run start <template-id> --agent <id|name> --task "<task>" [--contract <contract-id>] [--context-mode <full|intelligent|economical>] [--dry-run] [--workspace <id|name>] [--json]',
    "  compasso run <pause|resume|cancel> <run-id> [--workspace <id|name>] [--json]",
    "  compasso run retry <run-id> [node-id] [--rerun-scope <node|dependents>] [--workspace <id|name>] [--json]",
    "  compasso run alternative <run-id> <node-id> [--alternative-label <label>] [--workspace <id|name>] [--json]",
    "  compasso run alternatives <run-id> <node-id> [--workspace <id|name>] [--json]",
    "  compasso run <approve|reject> <run-id> <node-id> [--summary <note>] [--workspace <id|name>] [--json]",
    '  compasso proposal create "<objective>" [--summary <understanding>] [--workspace <id|name>] [--json]',
    "  compasso proposal <list|show|events> [proposal-id] [--workspace <id|name>] [--json]",
    '  compasso proposal revise <proposal-id> "<objective>" --revision <n> [--summary <understanding>] [--workspace <id|name>] [--json]',
    "  compasso proposal <approve|reject> <proposal-id> --revision <n> [--workspace <id|name>] [--json]",
    "  compasso profile show <agent> [--workspace <id|name>] [--json]",
    '  compasso mission set "<objective>" [--scope <item,...>] [--decisions <item,...>] [--constraints <item,...>]',
    "  compasso mission show [--workspace <id|name>] [--json]",
    "  compasso memory set [--stack <item,...>] [--architecture <text>] [--patterns <item,...>] [--commands <item,...>] [--conventions <item,...>] [--technical-decisions <item,...>]",
    "  compasso memory show [--workspace <id|name>] [--json]",
    "  compasso inbox <agent> [--workspace <id|name>] [--json]",
    "  compasso message <cancel|retry> <message-id> [--workspace <id|name>]",
    "  compasso history [--workspace <id|name>] [--agent <id|name>] [--type <kind>] [--state <state>] [--since <ISO>] [--until <ISO>] [--limit <1-500>] [--json]",
    '  compasso respond <message-id> --from <agent> "<response>"',
    "  compasso responses [message-id] [--workspace <id|name>] [--json]",
    "  compasso context <agent> [--from <agent>] [--workspace <id|name>] [--json]",
    '  compasso context build <agent> --task "<task>" [--contract <contract-id>] [--context-mode <full|intelligent|economical>] [--workspace <id|name>] [--json]',
    '  compasso checkpoint create <function|delivery> <agent> --task "<task>" [--contract <contract-id>] [--workspace <id|name>] [--json]',
    "  compasso checkpoint <list|show> [agent|checkpoint-id] [--workspace <id|name>] [--json]",
    "  compasso connect create <source> <target> [--type <context|handoff|dependency>] [--label <label>] [--from <agent>] [--revision <n>] [--idempotency-key <key>] [--json]",
    "  compasso connect <source> <target> (atalho para create)",
    "  compasso connect <list|show|remove> [connection-id] [--workspace <id|name>] [--json]",
    "  compasso impact <artifact> [--workspace <id|name>] [--json]",
    "  compasso spawn --agent <codex|claude-code> --role <role> --name <name> [--from <agent>]",
    "  compasso spawn retry <spawn-id> [--workspace <id|name>]",
    '  compasso note create --title "<title>" [--content "<content>"] [--from <agent>]',
    '  compasso note append <note> "<content>" [--from <agent>]',
    "  compasso note <list|show> [note] [--workspace <id|name>] [--json]",
    "  compasso artifact publish <path> [--kind <kind>] [--from <agent>]",
    "  compasso artifact <list|show> [artifact] [--workspace <id|name>] [--json]",
    "  compasso artifact memory <show|list> <artifact> [--workspace <id|name>] [--json]",
    "  compasso artifact memory compare <artifact> <base-version> <target-version> [--workspace <id|name>] [--json]",
    "  compasso artifact memory restore <artifact> <version> [--workspace <id|name>] [--json]",
    '  compasso artifact feedback create <artifact> <version> "<feedback>" [--workspace <id|name>] [--json]',
    "  compasso artifact feedback list <artifact> [version] [--workspace <id|name>] [--json]",
    "  compasso artifact memory set <artifact> --relevance <required|relevant|optional> --artifact-status <active|superseded|archived> [--relationships <artifact-id:kind,...>]",
    "  compasso contract create <source> <target> [--inputs <item,...>] [--outputs <item,...>] [--criteria <item,...>] [--evidence <kind:reference,...>]",
    "  compasso contract <list|show|verify> [contract-id] [--evidence <kind:reference,...>] [--workspace <id|name>] [--json]",
    '  compasso handoff <source> <target> [--summary "<summary>"] [--artifact <artifact>] [--from <agent>]',
    "  compasso handoff <list|show|history> [handoff] [--workspace <id|name>] [--json]",
    "  compasso handoff <approve|reject|cancel|retry> <handoff> --revision <n> [--summary <text>] [--from <agent>]"
  ].join("\n");
}
