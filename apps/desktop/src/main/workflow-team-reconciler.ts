import {
  toAgentAdapterId,
  workflowDraftSchema,
  type AgentAdapterId,
  type CanvasAgentRole,
  type CanvasNode,
  type CanvasSnapshot,
  type WorkflowDraft,
  type WorkflowNodeDraft,
  type WorkflowRole
} from "@forgedeck/schemas";

const EXECUTABLE_NODE_ID = /^[a-zA-Z0-9_-]+$/;

interface CanvasAgent {
  readonly node: CanvasNode;
  readonly adapter: AgentAdapterId;
  readonly role: WorkflowRole;
}

/**
 * Makes the generated plan respect the team the user already assembled on the canvas.
 *
 * The model is still free to decide the best work breakdown, but a compatible configured agent wins
 * over a generic generated node, keeps its stable canvas identity and remains pinned to its selected
 * adapter. Connected configured agents omitted by the plan are appended instead of silently ignored.
 * A plain shell terminal is intentionally not treated as an AI agent just because it has a role label.
 */
export function reconcileWorkflowDraftWithCanvasTeam(
  draft: WorkflowDraft,
  canvas: CanvasSnapshot
): WorkflowDraft {
  const agents = canvas.nodes.flatMap((node): CanvasAgent[] => {
    const adapter = toAgentAdapterId(node.data.adapterId);
    if (
      adapter === null ||
      !["agent", "terminal"].includes(node.type) ||
      !EXECUTABLE_NODE_ID.test(node.id)
    ) {
      return [];
    }
    return [{ node, adapter, role: canvasRole(node) }];
  });
  if (agents.length === 0) return draft;

  const usedAgentIds = new Set<string>();
  const remappedIds = new Map<string, string>();
  const nodes = draft.nodes.map((node) => {
    const match = agents.find(
      (agent) => !usedAgentIds.has(agent.node.id) && agent.role === node.role
    );
    if (match === undefined) return node;
    usedAgentIds.add(match.node.id);
    remappedIds.set(node.id, match.node.id);
    return bindNodeToCanvasAgent(node, match, connectedContextInputs(match.node.id, canvas));
  });

  const connectedAgentIds = connectedExecutableAgentIds(canvas, new Set(agents.map(agentId)));
  for (const agent of agents) {
    if (usedAgentIds.has(agent.node.id) || !connectedAgentIds.has(agent.node.id)) continue;
    usedAgentIds.add(agent.node.id);
    nodes.push(
      createNodeForCanvasAgent(
        agent,
        draft.objective,
        connectedContextInputs(agent.node.id, canvas)
      )
    );
  }

  const configuredIds = new Set(nodes.filter((node) => !node.generatedByOrchestrator).map(nodeId));
  const canvasRelations = canvas.edges.flatMap((edge) => {
    if (!configuredIds.has(edge.source) || !configuredIds.has(edge.target)) return [];
    if (edge.contract.kind !== "dependency" && edge.contract.kind !== "handoff") return [];
    return [
      {
        id: `canvas-${edge.id}`,
        sourceNodeId: edge.source,
        targetNodeId: edge.target,
        type: edge.contract.kind,
        contract: {
          requiredArtifacts:
            edge.contract.sourceDeliverable === undefined ? [] : [edge.contract.sourceDeliverable],
          requiredEvidence: [...edge.contract.requiredEvidenceTypes],
          completionCondition: edge.contract.targetInstruction ?? edge.contract.label
        }
      } satisfies WorkflowDraft["edges"][number]
    ];
  });
  const configuredPairs = new Set(
    canvasRelations.flatMap((edge) => [unorderedPair(edge.sourceNodeId, edge.targetNodeId)])
  );
  const generatedEdges = draft.edges
    .map((edge) => ({
      ...edge,
      sourceNodeId: remappedIds.get(edge.sourceNodeId) ?? edge.sourceNodeId,
      targetNodeId: remappedIds.get(edge.targetNodeId) ?? edge.targetNodeId
    }))
    .filter(
      (edge) =>
        !configuredPairs.has(unorderedPair(edge.sourceNodeId, edge.targetNodeId)) &&
        edge.sourceNodeId !== edge.targetNodeId
    );
  const seenEdges = new Set<string>();
  const edges = [...generatedEdges, ...canvasRelations].filter((edge) => {
    const key = `${edge.sourceNodeId}\u0000${edge.targetNodeId}\u0000${edge.type}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });

  return workflowDraftSchema.parse({ ...draft, nodes, edges });
}

function bindNodeToCanvasAgent(
  node: WorkflowNodeDraft,
  agent: CanvasAgent,
  contextInputs: WorkflowNodeDraft["inputs"]
): WorkflowNodeDraft {
  const role = agent.node.data.role;
  return {
    ...node,
    id: agent.node.id,
    title: role?.name.trim() || node.title,
    objective: mergeParagraphs(node.objective, roleObjective(role)),
    responsibilities: mergeLines(node.responsibilities, role?.responsibilities),
    constraints: mergeLines(node.constraints, role?.constraints),
    inputs: mergeInputs(node.inputs, contextInputs),
    expectedOutputs: mergeOutput(node.expectedOutputs, role?.expectedDeliverable),
    acceptanceCriteria: mergeLines(node.acceptanceCriteria, role?.completionCriteria),
    runtimeRequirement: {
      ...node.runtimeRequirement,
      strategy: "fixed",
      fixedRuntimeId: agent.adapter,
      resolvedRuntimeId: agent.adapter,
      resolutionReason: "Agente e função escolhidos pelo usuário no canvas."
    },
    agentAssignment: {
      ...(node.agentAssignment ?? {
        requiredCapabilities: [],
        recommendedAdapters: [],
        assignedAdapter: null,
        fallbackAdapters: [],
        recommendationReason: ""
      }),
      recommendedAdapters: [
        agent.adapter,
        ...(node.agentAssignment?.recommendedAdapters ?? []).filter(
          (adapter) => adapter !== agent.adapter
        )
      ],
      assignedAdapter: agent.adapter,
      fallbackAdapters: (node.agentAssignment?.fallbackAdapters ?? []).filter(
        (adapter) => adapter !== agent.adapter
      ),
      recommendationReason: "Agente escolhido pelo usuário para esta função no canvas."
    },
    lifecycle: "configured",
    generatedByOrchestrator: false
  };
}

function createNodeForCanvasAgent(
  agent: CanvasAgent,
  objective: string,
  contextInputs: WorkflowNodeDraft["inputs"]
): WorkflowNodeDraft {
  const role = agent.node.data.role;
  return {
    id: agent.node.id,
    title: role?.name.trim() || agent.node.data.title,
    role: agent.role,
    objective: mergeParagraphs(
      `Contribua para o objetivo do fluxo: ${objective}`,
      roleObjective(role)
    ),
    responsibilities: mergeLines([], role?.responsibilities),
    constraints: mergeLines([], role?.constraints),
    inputs: contextInputs,
    expectedOutputs: mergeOutput([], role?.expectedDeliverable),
    acceptanceCriteria: mergeLines([], role?.completionCriteria),
    runtimeRequirement: {
      strategy: "fixed",
      fixedRuntimeId: agent.adapter,
      preferredProviders: [],
      requiredCapabilities: [],
      resolvedRuntimeId: agent.adapter,
      resolutionReason: "Agente e função escolhidos pelo usuário no canvas."
    },
    agentAssignment: {
      requiredCapabilities: [],
      recommendedAdapters: [agent.adapter],
      assignedAdapter: agent.adapter,
      fallbackAdapters: [],
      recommendationReason: "Agente escolhido pelo usuário para esta função no canvas."
    },
    execution: {
      canRunInParallel: false,
      estimatedComplexity: "medium",
      requiresHumanApproval: false
    },
    contextPolicy: {
      inheritRootContext: true,
      assetRefs: [],
      includeFullConversation: false,
      includeUpstreamHandoffs: true
    },
    lifecycle: "configured",
    generatedByOrchestrator: false
  };
}

function canvasRole(node: CanvasNode): WorkflowRole {
  const value = normalize(`${node.data.role?.name ?? ""} ${node.data.title}`);
  if (matches(value, ["orquestr", "orchestrat"])) return "orchestrator";
  if (matches(value, ["planej", "plannej", "planner", "arquitet", "architect"])) return "planner";
  if (matches(value, ["pesquis", "research"])) return "researcher";
  if (matches(value, ["estrateg", "strateg"])) return "strategist";
  if (matches(value, ["design", "ux", "ui"])) return "designer";
  if (
    matches(value, [
      "implement",
      "desenvolv",
      "developer",
      "frontend",
      "front-end",
      "backend",
      "footer"
    ])
  ) {
    return "implementer";
  }
  if (matches(value, ["revisor", "revisao", "review"])) return "reviewer";
  if (matches(value, ["qualidade", "teste", "testador", "qa"])) return "qa";
  if (matches(value, ["seguranca", "security"])) return "security";
  return "custom";
}

function connectedExecutableAgentIds(
  canvas: CanvasSnapshot,
  agentIds: ReadonlySet<string>
): ReadonlySet<string> {
  const connected = new Set<string>();
  for (const edge of canvas.edges) {
    if (agentIds.has(edge.source)) connected.add(edge.source);
    if (agentIds.has(edge.target)) connected.add(edge.target);
  }
  return connected;
}

function roleObjective(role: CanvasAgentRole | undefined): string {
  if (role === undefined) return "";
  const details = [
    `Função configurada no canvas: ${role.name}.`,
    role.responsibilities.trim().length === 0
      ? ""
      : `Responsabilidades: ${role.responsibilities.trim()}`,
    role.constraints.trim().length === 0 ? "" : `Restrições: ${role.constraints.trim()}`,
    role.expectedDeliverable.trim().length === 0
      ? ""
      : `Entrega esperada: ${role.expectedDeliverable.trim()}`,
    role.completionCriteria.trim().length === 0
      ? ""
      : `Critério de conclusão: ${role.completionCriteria.trim()}`
  ].filter((entry) => entry.length > 0);
  return details.join("\n");
}

function mergeParagraphs(first: string, second: string): string {
  if (second.trim().length === 0) return first;
  if (first.trim().length === 0) return second;
  return `${first.trim()}\n\n${second.trim()}`.slice(0, 8_000);
}

function mergeLines(current: readonly string[], value: string | undefined): string[] {
  const addition = value?.trim();
  if (addition === undefined || addition.length === 0 || current.includes(addition)) {
    return [...current];
  }
  return [...current, addition].slice(0, 32);
}

function mergeOutput(
  current: WorkflowNodeDraft["expectedOutputs"],
  value: string | undefined
): WorkflowNodeDraft["expectedOutputs"] {
  const addition = value?.trim();
  if (addition === undefined || addition.length === 0) return [...current];
  if (current.some((output) => output.description === addition)) return [...current];
  return [...current, { label: "Entrega da função configurada", description: addition }].slice(
    0,
    32
  );
}

function mergeInputs(
  current: WorkflowNodeDraft["inputs"],
  additions: WorkflowNodeDraft["inputs"]
): WorkflowNodeDraft["inputs"] {
  const seen = new Set(current.map((entry) => `${entry.label}\u0000${entry.description}`));
  return [
    ...current,
    ...additions.filter((entry) => !seen.has(`${entry.label}\u0000${entry.description}`))
  ].slice(0, 32);
}

function connectedContextInputs(
  agentNodeId: string,
  canvas: CanvasSnapshot
): WorkflowNodeDraft["inputs"] {
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  const neighbors = new Map<string, string[]>();
  for (const edge of canvas.edges) {
    neighbors.set(edge.source, [...(neighbors.get(edge.source) ?? []), edge.target]);
    neighbors.set(edge.target, [...(neighbors.get(edge.target) ?? []), edge.source]);
  }
  const queue = [...(neighbors.get(agentNodeId) ?? [])];
  const visited = new Set([agentNodeId]);
  const inputs: WorkflowNodeDraft["inputs"] = [];
  while (queue.length > 0 && inputs.length < 12) {
    const nodeId = queue.shift();
    if (nodeId === undefined || visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = byId.get(nodeId);
    if (
      node === undefined ||
      toAgentAdapterId(node.data.adapterId) !== null ||
      node.type === "terminal"
    ) {
      continue;
    }
    const description = contextDescription(node);
    if (description.length > 0) {
      inputs.push({
        label: `Contexto conectado: ${node.data.title}`.slice(0, 160),
        description: description.slice(0, 2_000)
      });
    }
    for (const neighbor of neighbors.get(nodeId) ?? []) {
      if (!visited.has(neighbor)) queue.push(neighbor);
    }
  }
  return inputs;
}

function contextDescription(node: CanvasNode): string {
  if (node.type === "note") return (node.data.content ?? node.data.summary).trim();
  const source = node.data.contextSource;
  if (source?.content !== undefined) return source.content.trim();
  if (source?.url !== undefined) return `Referência: ${source.url}`;
  if (source?.filename !== undefined) return `Material conectado: ${source.filename}`;
  return node.data.summary.trim();
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

function matches(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function unorderedPair(left: string, right: string): string {
  return [left, right].sort().join("\u0000");
}

function agentId(agent: CanvasAgent): string {
  return agent.node.id;
}

function nodeId(node: WorkflowNodeDraft): string {
  return node.id;
}
