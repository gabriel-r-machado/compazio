import { redactText } from "@forgedeck/logger";
import type { AgentAdapter } from "@forgedeck/agent-sdk";
import {
  handoffApprovedContentSchema,
  handoffDraftContentSchema,
  handoffListRequestSchema
} from "@forgedeck/schemas";
import type {
  AgentPermission,
  CanvasHandoff,
  CanvasHandoffEvent,
  CanvasSnapshot,
  HandoffApprovedContent,
  HandoffAwaitDestinationRequest,
  HandoffCancelDeliveryRequest,
  HandoffCreateDraftRequest,
  HandoffDeliverRequest,
  HandoffDraftContent,
  HandoffListRequest,
  HandoffMarkSentRequest,
  HandoffMarkReadyRequest,
  HandoffRetryRequest,
  HandoffUpdateDraftRequest,
  TerminalAdapterId
} from "@forgedeck/schemas";

interface HandoffStore {
  createDraft(input: {
    readonly canvasId: string;
    readonly projectId: string;
    readonly mission: string;
    readonly source: CanvasHandoff["source"];
    readonly target: CanvasHandoff["target"];
    readonly edge: CanvasHandoff["edge"];
    readonly content?: HandoffDraftContent;
  }): CanvasHandoff;
  get(handoffId: string): CanvasHandoff | null;
  listByCanvas(canvasId: string, limit?: number): CanvasHandoff[];
  listEvents(handoffId: string): CanvasHandoffEvent[];
  updateDraft(handoffId: string, revision: number, content: HandoffDraftContent): CanvasHandoff;
  markReady(handoffId: string, revision: number, content: HandoffApprovedContent): CanvasHandoff;
  beginDelivery(
    handoffId: string,
    revision: number,
    input: { readonly targetSessionId: string; readonly adapterId: string }
  ): CanvasHandoff;
  markWrittenToTerminal(
    handoffId: string,
    revision: number,
    deliveryAttemptId: string
  ): CanvasHandoff;
  markSubmittedToAgent(
    handoffId: string,
    revision: number,
    deliveryAttemptId: string
  ): CanvasHandoff;
  markDelivered(handoffId: string, revision: number, deliveryAttemptId: string): CanvasHandoff;
  markAwaitingDestination(handoffId: string, revision: number, error: string): CanvasHandoff;
  markSentManually(handoffId: string, revision: number, deliveryAttemptId: string): CanvasHandoff;
  cancelDelivery(handoffId: string, revision: number): CanvasHandoff;
  markFailed(
    handoffId: string,
    revision: number,
    deliveryAttemptId: string | null,
    error: string
  ): CanvasHandoff;
  markDeliveryUnknown(
    handoffId: string,
    revision: number,
    deliveryAttemptId: string | null,
    error: string
  ): CanvasHandoff;
  requestRetry(handoffId: string, revision: number): CanvasHandoff;
}

interface CanvasReader {
  load(canvasId: string): CanvasSnapshot | null;
}

interface WorkspaceReader {
  list(): readonly { readonly id: string; readonly canvasId: string; readonly projectId: string }[];
}

interface PolicyAuthorizer {
  assertAllowed(input: {
    readonly workspaceId: string;
    readonly actorNodeId: null;
    readonly permission: AgentPermission;
  }): unknown;
}

interface SessionAccessReader {
  get(sessionId: string): {
    readonly projectId: string;
    readonly adapterId: TerminalAdapterId;
  } | null;
}

interface TerminalWriter {
  getSession(sessionId: string): { readonly state: string };
  getBufferSnapshot(sessionId: string): { readonly data: string; readonly sequence: number };
  write(sessionId: string, data: string): Promise<void>;
}

interface AdapterResolver {
  get(adapterId: string): AgentAdapter;
}

export interface HandoffServiceDependencies {
  readonly store: HandoffStore;
  readonly canvases: CanvasReader;
  readonly workspaces: WorkspaceReader;
  readonly sessions: SessionAccessReader;
  readonly terminal: TerminalWriter;
  readonly adapters: AdapterResolver;
  readonly policy: PolicyAuthorizer;
}

const activeTerminalStates = new Set(["running", "waiting"]);
const maximumPromptLength = 60 * 1024;
const handoffResponseTimeoutMs = 12_000;

export class HandoffService {
  private readonly inFlight = new Set<string>();

  public constructor(private readonly dependencies: HandoffServiceDependencies) {}

  public createDraft(request: HandoffCreateDraftRequest): CanvasHandoff {
    const canvas = this.dependencies.canvases.load(request.canvasId);
    if (canvas === null) throw new Error("Canvas not found");
    const workspace = this.dependencies.workspaces
      .list()
      .find((candidate) => candidate.canvasId === request.canvasId);
    if (workspace === undefined) throw new Error("Canvas is not associated with a workspace");
    this.dependencies.policy.assertAllowed({
      workspaceId: workspace.id,
      actorNodeId: null,
      permission: "create_handoffs"
    });

    const source = canvas.nodes.find((node) => node.id === request.sourceNodeId);
    const target = canvas.nodes.find((node) => node.id === request.targetNodeId);
    const edge = canvas.edges.find((candidate) => candidate.id === request.edgeId);
    if (source === undefined || target === undefined || edge === undefined) {
      throw new Error("Handoff route no longer exists in the saved canvas");
    }
    if (edge.source !== source.id || edge.target !== target.id) {
      throw new Error("Handoff edge does not match its source and target");
    }
    if (!isTerminalNode(source.type) || !isTerminalNode(target.type)) {
      throw new Error("Handoffs require terminal or agent nodes");
    }
    if (source.data.role === undefined || target.data.role === undefined) {
      throw new Error("Configure the role of both terminals before creating a handoff");
    }
    const mission = redactText(canvas.mission?.trim() ?? "");
    if (mission.length === 0)
      throw new Error("Write the workspace mission before creating a handoff");

    return this.dependencies.store.createDraft({
      canvasId: canvas.id,
      projectId: workspace.projectId,
      mission,
      source: {
        nodeId: source.id,
        title: redactText(source.data.title),
        role: redactRole(source.data.role)
      },
      target: {
        nodeId: target.id,
        title: redactText(target.data.title),
        role: redactRole(target.data.role)
      },
      edge: {
        edgeId: edge.id,
        contract: {
          ...edge.contract,
          label: redactText(edge.contract.label),
          handoffMode: "manual",
          ...(edge.contract.sourceDeliverable === undefined
            ? {}
            : { sourceDeliverable: redactText(edge.contract.sourceDeliverable) }),
          ...(edge.contract.targetInstruction === undefined
            ? {}
            : { targetInstruction: redactText(edge.contract.targetInstruction) })
        }
      },
      content: handoffDraftContentSchema.parse({})
    });
  }

  public updateDraft(request: HandoffUpdateDraftRequest): CanvasHandoff {
    this.authorizeHandoff(request.handoffId, "create_handoffs");
    return this.dependencies.store.updateDraft(
      request.handoffId,
      request.revision,
      redactContent(request.content)
    );
  }

  public markReady(request: HandoffMarkReadyRequest): CanvasHandoff {
    this.authorizeHandoff(request.handoffId, "approve_deliveries");
    return this.dependencies.store.markReady(
      request.handoffId,
      request.revision,
      handoffApprovedContentSchema.parse(redactContent(request.content))
    );
  }

  public async deliver(request: HandoffDeliverRequest): Promise<CanvasHandoff> {
    const handoff = this.requireHandoff(request.handoffId);
    if (handoff.status !== "ready") {
      throw new Error(`Handoff must be ready before delivery; found ${handoff.status}`);
    }
    this.authorizeCanvas(handoff.canvasId, "approve_deliveries");
    return this.deliverReady(handoff, request.targetSessionId);
  }

  public awaitDestination(request: HandoffAwaitDestinationRequest): CanvasHandoff {
    const handoff = this.requireHandoff(request.handoffId);
    if (handoff.status === "awaiting_destination") return handoff;
    if (handoff.status !== "ready") {
      throw new Error(`Handoff cannot await a destination from ${handoff.status}`);
    }
    this.authorizeCanvas(handoff.canvasId, "approve_deliveries");
    return this.dependencies.store.markAwaitingDestination(
      handoff.id,
      request.revision,
      "Target terminal session is not active"
    );
  }

  public async retry(request: HandoffRetryRequest): Promise<CanvasHandoff> {
    const current = this.requireHandoff(request.handoffId);
    if (
      current.status !== "failed" &&
      current.status !== "delivery_unknown" &&
      current.status !== "awaiting_destination" &&
      current.status !== "cancelled"
    ) {
      throw new Error(`Handoff cannot retry from ${current.status}`);
    }
    this.authorizeCanvas(current.canvasId, "approve_deliveries");
    const ready = this.dependencies.store.requestRetry(current.id, request.revision);
    return this.deliverReady(ready, request.targetSessionId);
  }

  public markSent(request: HandoffMarkSentRequest): CanvasHandoff {
    const handoff = this.requireHandoff(request.handoffId);
    if (handoff.status !== "delivery_unknown") {
      throw new Error(`Handoff cannot be marked sent from ${handoff.status}`);
    }
    this.authorizeCanvas(handoff.canvasId, "approve_deliveries");
    return this.dependencies.store.markSentManually(
      handoff.id,
      request.revision,
      request.deliveryAttemptId
    );
  }

  public cancelDelivery(request: HandoffCancelDeliveryRequest): CanvasHandoff {
    const handoff = this.requireHandoff(request.handoffId);
    this.authorizeCanvas(handoff.canvasId, "approve_deliveries");
    return this.dependencies.store.cancelDelivery(handoff.id, request.revision);
  }

  public list(request: HandoffListRequest): CanvasHandoff[] {
    const parsed = handoffListRequestSchema.parse(request);
    return this.dependencies.store.listByCanvas(parsed.canvasId, parsed.limit);
  }

  public listEvents(handoffId: string): CanvasHandoffEvent[] {
    this.requireHandoff(handoffId);
    return this.dependencies.store.listEvents(handoffId);
  }

  private authorizeHandoff(handoffId: string, permission: AgentPermission): void {
    this.authorizeCanvas(this.requireHandoff(handoffId).canvasId, permission);
  }

  private authorizeCanvas(canvasId: string, permission: AgentPermission): void {
    const workspace = this.dependencies.workspaces
      .list()
      .find((candidate) => candidate.canvasId === canvasId);
    if (workspace === undefined) throw new Error("Canvas is not associated with a workspace");
    this.dependencies.policy.assertAllowed({
      workspaceId: workspace.id,
      actorNodeId: null,
      permission
    });
  }

  private async deliverReady(
    handoff: CanvasHandoff,
    targetSessionId: string
  ): Promise<CanvasHandoff> {
    const access = this.dependencies.sessions.get(targetSessionId);
    if (access === null)
      return this.awaitDestinationFor(handoff, "Target terminal session is not registered");
    if (access.projectId !== handoff.projectId) {
      throw new Error("Target terminal belongs to a different project");
    }
    if (access.adapterId === "shell") {
      throw new Error("Handoffs can only be delivered to an agent terminal");
    }
    let session: { readonly state: string };
    try {
      session = this.dependencies.terminal.getSession(targetSessionId);
    } catch {
      return this.awaitDestinationFor(handoff, "Target terminal session is unavailable");
    }
    if (!activeTerminalStates.has(session.state)) {
      return this.awaitDestinationFor(handoff, "Target terminal session is not active");
    }
    const adapter = this.dependencies.adapters.get(access.adapterId);
    if (
      !adapter.isReadyForReviewedHandoff(
        this.dependencies.terminal.getBufferSnapshot(targetSessionId)
      )
    ) {
      throw new Error("Target adapter is not ready to receive a reviewed handoff");
    }
    if (this.inFlight.has(handoff.id)) {
      throw new Error("This handoff is already being submitted");
    }

    const prompt = redactText(formatHandoffPrompt(handoff));
    if (prompt.length > maximumPromptLength) {
      throw new Error("Reviewed handoff is too large to deliver safely");
    }
    this.inFlight.add(handoff.id);
    let current = handoff;
    let attemptId: string | null = null;
    try {
      current = this.dependencies.store.beginDelivery(handoff.id, handoff.revision, {
        targetSessionId,
        adapterId: access.adapterId
      });
      const attempt = current.deliveryAttempts.at(-1);
      if (attempt === undefined) throw new Error("Handoff delivery attempt was not persisted");
      const deliveryAttemptId = attempt.id;
      attemptId = deliveryAttemptId;
      await adapter.submitReviewedHandoff(
        {
          write: async (data) => this.dependencies.terminal.write(targetSessionId, data),
          getOutputSnapshot: () => this.dependencies.terminal.getBufferSnapshot(targetSessionId),
          waitForOutputAfter: (sequence, timeoutMs) =>
            this.waitForOutputAfter(targetSessionId, sequence, timeoutMs),
          reportPhase: async (phase) => {
            current =
              phase === "written_to_terminal"
                ? this.dependencies.store.markWrittenToTerminal(
                    current.id,
                    current.revision,
                    deliveryAttemptId
                  )
                : this.dependencies.store.markSubmittedToAgent(
                    current.id,
                    current.revision,
                    deliveryAttemptId
                  );
          }
        },
        prompt
      );
      return this.dependencies.store.markDelivered(current.id, current.revision, deliveryAttemptId);
    } catch (error: unknown) {
      const message = redactText(error instanceof Error ? error.message : "Terminal write failed");
      if (attemptId !== null) {
        if (current.status === "submitted_to_agent") {
          this.dependencies.store.markDeliveryUnknown(
            current.id,
            current.revision,
            attemptId,
            message
          );
        } else {
          this.dependencies.store.markFailed(current.id, current.revision, attemptId, message);
        }
      }
      throw new Error(`Handoff delivery failed: ${message}`, { cause: error });
    } finally {
      this.inFlight.delete(handoff.id);
    }
  }

  private awaitDestinationFor(handoff: CanvasHandoff, error: string): CanvasHandoff {
    return this.dependencies.store.markAwaitingDestination(
      handoff.id,
      handoff.revision,
      redactText(error)
    );
  }

  private async waitForOutputAfter(
    sessionId: string,
    sequence: number,
    timeoutMs: number
  ): Promise<{ readonly data: string; readonly sequence: number } | null> {
    const deadline = Date.now() + Math.min(timeoutMs, handoffResponseTimeoutMs);
    while (Date.now() < deadline) {
      const snapshot = this.dependencies.terminal.getBufferSnapshot(sessionId);
      if (snapshot.sequence > sequence) return snapshot;
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    return null;
  }

  private requireHandoff(handoffId: string): CanvasHandoff {
    const handoff = this.dependencies.store.get(handoffId);
    if (handoff === null) throw new Error("Handoff not found");
    return handoff;
  }
}

export function formatHandoffPrompt(handoff: CanvasHandoff): string {
  const sections = [
    "COMPASSO — ENTREGA APROVADA",
    section("MISSÃO", handoff.mission),
    section("SEU PAPEL", formatRole(handoff.target.title, handoff.target.role)),
    section("PAPEL DA ORIGEM", formatRole(handoff.source.title, handoff.source.role)),
    section(
      "CONTRATO",
      [
        handoff.edge.contract.sourceDeliverable === undefined
          ? "Entrega esperada da origem: não especificada"
          : `Entrega esperada da origem: ${handoff.edge.contract.sourceDeliverable}`,
        handoff.edge.contract.targetInstruction === undefined
          ? "Próxima ação: revisar a entrega"
          : `Próxima ação: ${handoff.edge.contract.targetInstruction}`
      ].join("\n")
    ),
    section("RESUMO APROVADO", handoff.content.summary),
    listSection("TRABALHO CONCLUÍDO", handoff.content.completedWork),
    listSection("DECISÕES", handoff.content.decisions),
    listSection(
      "EVIDÊNCIAS",
      handoff.content.evidence.map((item) => `${item.label}: ${item.detail}`)
    ),
    listSection("QUESTÕES EM ABERTO", handoff.content.openQuestions),
    listSection("RISCOS", handoff.content.risks),
    "Use esta entrega como contexto. Valide as evidências; não presuma que uma afirmação prova sucesso."
  ];
  return sections.filter((value) => value !== "").join("\n\n");
}

function redactContent(content: HandoffDraftContent): HandoffDraftContent {
  return handoffDraftContentSchema.parse({
    summary: redactText(content.summary),
    completedWork: content.completedWork.map(redactText),
    decisions: content.decisions.map(redactText),
    evidence: content.evidence.map((item) => ({
      label: redactText(item.label),
      detail: redactText(item.detail)
    })),
    openQuestions: content.openQuestions.map(redactText),
    risks: content.risks.map(redactText)
  });
}

function redactRole(role: CanvasHandoff["source"]["role"]) {
  return {
    name: redactText(role.name),
    responsibilities: redactText(role.responsibilities),
    constraints: redactText(role.constraints),
    expectedDeliverable: redactText(role.expectedDeliverable),
    completionCriteria: redactText(role.completionCriteria)
  };
}

function formatRole(title: string, role: CanvasHandoff["source"]["role"]): string {
  return [
    `${title} — ${role.name}`,
    `Responsabilidades: ${role.responsibilities}`,
    `Restrições: ${role.constraints}`,
    `Entrega esperada: ${role.expectedDeliverable}`,
    `Critério de conclusão: ${role.completionCriteria}`
  ].join("\n");
}

function section(title: string, value: string): string {
  return `${title}\n${value}`;
}

function listSection(title: string, values: readonly string[]): string {
  return values.length === 0 ? "" : `${title}\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function isTerminalNode(type: CanvasSnapshot["nodes"][number]["type"]): boolean {
  return type === "terminal" || type === "agent";
}
