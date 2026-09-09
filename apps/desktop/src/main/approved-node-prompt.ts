import type { WorkflowDraft } from "@forgedeck/schemas";

/** Complete instruction persisted separately from the official workflow definition for one run/node. */
export function buildApprovedNodePrompt(
  draft: WorkflowDraft,
  node: WorkflowDraft["nodes"][number]
): string {
  const section = (label: string, values: readonly string[]): string =>
    values.length === 0 ? "" : `${label}:\n${values.map((value) => `- ${value}`).join("\n")}`;
  return [
    `Missão do fluxo:\n${draft.objective}`,
    `Sua função:\n${node.title} (${node.role})`,
    node.objective.length === 0 ? "" : `Objetivo desta função:\n${node.objective}`,
    section("Responsabilidades", node.responsibilities),
    section("Restrições", node.constraints),
    section(
      "Entradas esperadas",
      node.inputs.map((entry) => `${entry.label}: ${entry.description}`)
    ),
    section(
      "Entregas esperadas",
      node.expectedOutputs.map((entry) => `${entry.label}: ${entry.description}`)
    ),
    section("Critérios de aceite", node.acceptanceCriteria),
    node.contextPolicy.includeUpstreamHandoffs
      ? "Consuma e respeite os artefatos oficiais entregues pelos agentes anteriores."
      : ""
  ]
    .filter((value) => value.length > 0)
    .join("\n\n")
    .slice(0, 20_000);
}
