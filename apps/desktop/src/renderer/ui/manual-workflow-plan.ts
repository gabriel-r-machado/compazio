import { toAgentAdapterId } from "@forgedeck/schemas";
import type {
  AgentAdapterId,
  OrchestratorCompositionAction,
  WorkflowRole
} from "@forgedeck/schemas";

import type { ForgeFlowEdge, ForgeFlowNode } from "./canvas-store";

export interface ManualWorkflowPlanNode {
  readonly ref: string;
  readonly adapterId: AgentAdapterId;
  readonly role: WorkflowRole;
  readonly action: Extract<OrchestratorCompositionAction, { type: "add_draft_node" }>;
}

export interface ManualWorkflowPlanEdge {
  readonly from: string;
  readonly to: string;
  readonly action: Extract<OrchestratorCompositionAction, { type: "connect_draft_nodes" }>;
}

export interface ManualWorkflowPlan {
  readonly nodes: readonly ManualWorkflowPlanNode[];
  readonly edges: readonly ManualWorkflowPlanEdge[];
  readonly ignoredShellRoles: readonly string[];
}

/** Converts the visible hand-built graph into the same reviewed draft/runtime used by Automatic. */
export function createManualWorkflowPlan(input: {
  readonly mission: string;
  readonly nodes: readonly ForgeFlowNode[];
  readonly edges: readonly ForgeFlowEdge[];
}): ManualWorkflowPlan {
  const usedRefs = new Set<string>();
  const refByNodeId = new Map<string, string>();
  const nodes = input.nodes.flatMap((node): ManualWorkflowPlanNode[] => {
    const adapterId = toAgentAdapterId(node.data.adapterId);
    if (adapterId === null) return [];
    const ref = uniqueRef(node.id, usedRefs);
    refByNodeId.set(node.id, ref);
    const role = roleFromNode(node);
    const configuredRole = node.data.role;
    const responsibilities = splitRoleText(configuredRole?.responsibilities);
    const constraints = splitRoleText(configuredRole?.constraints);
    const expectedDeliverable = configuredRole?.expectedDeliverable.trim() ?? "";
    const completionCriteria = configuredRole?.completionCriteria.trim() ?? "";
    return [
      {
        ref,
        adapterId,
        role,
        action: {
          type: "add_draft_node",
          ref,
          title: (configuredRole?.name.trim() || node.data.title).slice(0, 160),
          role,
          objective: [
            `Execute sua função dentro desta missão: ${input.mission}`,
            configuredRole === undefined
              ? ""
              : `Função definida pelo usuário: ${configuredRole.name}.`
          ]
            .filter((value) => value.length > 0)
            .join("\n\n")
            .slice(0, 8_000),
          responsibilities,
          constraints,
          inputs: connectedContextInputs(node.id, input.nodes, input.edges),
          expectedOutputs:
            expectedDeliverable.length === 0
              ? []
              : [
                  {
                    label: "Entrega da função",
                    description: expectedDeliverable.slice(0, 2_000)
                  }
                ],
          acceptanceCriteria:
            completionCriteria.length === 0 ? [] : [completionCriteria.slice(0, 2_000)],
          runtimeRequirement: {
            strategy: "fixed",
            fixedRuntimeId: adapterId,
            preferredProviders: [],
            requiredCapabilities: [],
            resolvedRuntimeId: adapterId,
            resolutionReason: "Agente escolhido pelo usuário no canvas."
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
          }
        }
      }
    ];
  });
  const edges = input.edges.flatMap((edge): ManualWorkflowPlanEdge[] => {
    const from = refByNodeId.get(edge.source);
    const to = refByNodeId.get(edge.target);
    if (from === undefined || to === undefined) return [];
    const edgeType = edge.data?.kind === "handoff" ? "handoff" : "dependency";
    return [
      {
        from,
        to,
        action: {
          type: "connect_draft_nodes",
          from,
          to,
          edgeType,
          requiredArtifacts:
            edge.data?.sourceDeliverable === undefined ? [] : [edge.data.sourceDeliverable],
          requiredEvidence: [...(edge.data?.requiredEvidenceTypes ?? [])],
          completionCondition:
            edge.data?.targetInstruction ?? edge.data?.label ?? "Etapa anterior concluída."
        }
      }
    ];
  });
  const ignoredShellRoles = input.nodes.flatMap((node) =>
    node.data.adapterId === "shell" && node.data.role !== undefined ? [node.data.role.name] : []
  );
  return { nodes, edges, ignoredShellRoles };
}

function roleFromNode(node: ForgeFlowNode): WorkflowRole {
  const value = normalize(`${node.data.role?.name ?? ""} ${node.data.title}`);
  if (has(value, ["orquestr", "orchestrat"])) return "orchestrator";
  if (has(value, ["planej", "planner", "arquitet", "architect"])) return "planner";
  if (has(value, ["pesquis", "research"])) return "researcher";
  if (has(value, ["estrateg", "strateg"])) return "strategist";
  if (has(value, ["design", "ux", "ui"])) return "designer";
  if (
    has(value, [
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
  if (has(value, ["revisor", "revisao", "review"])) return "reviewer";
  if (has(value, ["qualidade", "teste", "testador", "qa"])) return "qa";
  if (has(value, ["seguranca", "security"])) return "security";
  return "custom";
}

function uniqueRef(nodeId: string, used: Set<string>): string {
  const base =
    normalize(nodeId)
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^[^a-z0-9]+/u, "")
      .slice(0, 56) || "agent";
  let ref = base;
  let ordinal = 2;
  while (used.has(ref)) {
    ref = `${base.slice(0, 60)}-${ordinal}`;
    ordinal += 1;
  }
  used.add(ref);
  return ref;
}

function splitRoleText(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(/\r?\n|[;•]/u)
    .map((entry) => entry.trim().slice(0, 2_000))
    .filter((entry) => entry.length > 0)
    .slice(0, 32);
}

function connectedContextInputs(
  agentNodeId: string,
  nodes: readonly ForgeFlowNode[],
  edges: readonly ForgeFlowEdge[]
): { readonly label: string; readonly description: string }[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const neighbors = new Map<string, string[]>();
  for (const edge of edges) {
    neighbors.set(edge.source, [...(neighbors.get(edge.source) ?? []), edge.target]);
    neighbors.set(edge.target, [...(neighbors.get(edge.target) ?? []), edge.source]);
  }
  const queue = [...(neighbors.get(agentNodeId) ?? [])];
  const visited = new Set([agentNodeId]);
  const inputs: { readonly label: string; readonly description: string }[] = [];
  while (queue.length > 0 && inputs.length < 12) {
    const nodeId = queue.shift();
    if (nodeId === undefined || visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = byId.get(nodeId);
    if (node === undefined || toAgentAdapterId(node.data.adapterId) !== null) continue;
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

function contextDescription(node: ForgeFlowNode): string {
  if (node.type === "note") return (node.data.content ?? node.data.summary).trim();
  const source = node.data.contextSource;
  if (source?.content !== undefined) return source.content.trim();
  if (source?.url !== undefined) return `Referência: ${source.url}`;
  if (source?.filename !== undefined) {
    return [
      `Material: ${source.filename}`,
      source.mediaType === undefined ? "" : `Tipo: ${source.mediaType}`,
      source.sha256 === undefined ? "" : `SHA-256: ${source.sha256}`
    ]
      .filter((value) => value.length > 0)
      .join("\n");
  }
  return node.data.summary.trim();
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

function has(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}
