import {
  ORCHESTRATOR_PLAN_EXAMPLE,
  ORCHESTRATOR_PLAN_NODE_FIELDS,
  ORCHESTRATOR_PLAN_REQUIRED_NODE_FIELDS,
  ORCHESTRATOR_PLAN_REQUIRED_ROOT_FIELDS,
  ORCHESTRATOR_PLAN_ROLES
} from "@forgedeck/schemas";

/**
 * The response contract every planner receives, rendered from the plan schema's own constants and a
 * schema-validated example. It is never a hand-maintained list, so a schema change cannot leave a
 * prompt telling an agent something the validator will then reject.
 *
 * Claude and Codex share THIS text, not a per-provider variant: two planners asked for different
 * shapes would be two schemas in practice, however identical the validator looked.
 */

/** Actions analysis may never take. Stated to the model, and independently enforced by isolation. */
export const READ_ONLY_CONTRACT: readonly string[] = [
  "Do not edit, create, move or delete any file.",
  "Do not run any destructive or state-changing command.",
  "Do not commit, push, tag, merge or rebase.",
  "Do not deploy or touch any production system.",
  "Do not install, update or remove dependencies.",
  "Read and analyze only, then answer with JSON."
];

export function planContractSection(allowedAdapters: readonly string[]): readonly string[] {
  return [
    "## Required answer",
    "Answer with EXACTLY ONE JSON object and nothing else.",
    "- No markdown fence, no ``` of any kind.",
    "- No text before the JSON and no text after it.",
    "- No commentary, no explanation, no apology.",
    "",
    "### Required root keys (all of them, always)",
    ...ORCHESTRATOR_PLAN_REQUIRED_ROOT_FIELDS.map((field) => `- ${field}`),
    `Optional root keys: ${optionalOf(
      ["title", "summary", "nodes", "assumptions", "needsHumanApproval"],
      ORCHESTRATOR_PLAN_REQUIRED_ROOT_FIELDS
    )}`,
    "",
    "### Required keys on EVERY node (all of them, always)",
    ...ORCHESTRATOR_PLAN_REQUIRED_NODE_FIELDS.map((field) => `- ${field}`),
    `Every node key: ${ORCHESTRATOR_PLAN_NODE_FIELDS.join(", ")}`,
    "A node missing any required key makes the whole answer invalid.",
    "",
    "### Allowed values",
    `- role MUST be exactly one of: ${ORCHESTRATOR_PLAN_ROLES.join(" | ")}`,
    `- adapter MUST be exactly one of: ${allowedAdapters.join(" | ")}`,
    "- operationRisk MUST be one of: safe | caution | destructive",
    "- Never invent a role or an adapter that is not in these lists.",
    "",
    "### Structural rules",
    "- Every node id is unique and matches [a-zA-Z0-9_-]+.",
    "- Every entry of dependsOn names an existing node id in this same plan.",
    "- A node never depends on itself and the dependencies contain NO cycle.",
    "- Each node's prompt must stand alone: its agent receives only that text.",
    "- Mark operationRisk above safe, or requiresHumanApproval, for anything that deletes files,",
    "  migrates data destructively, deploys, pushes, touches production, uses credentials or",
    "  installs dependencies.",
    "- Prefer verificationCommands that are already available scripts.",
    "",
    "### A complete, valid example (copy this structure exactly)",
    JSON.stringify(ORCHESTRATOR_PLAN_EXAMPLE, null, 2),
    "",
    "### Check silently before answering",
    "1. Every node has every required key listed above.",
    "2. Every role is from the allowed list.",
    "3. Every adapter is from the allowed list.",
    "4. All node ids are unique.",
    "5. Every dependency points at a node that exists in this plan.",
    "6. There is no cycle.",
    "7. The mode's limits above are respected.",
    "8. The answer is one JSON object and nothing else.",
    "Do not report this checklist. Answer with the JSON object only."
  ];
}

/** Names the keys that are NOT required, so the contract states both halves without a second hand-list. */
function optionalOf(all: readonly string[], required: readonly string[]): string {
  const optional = all.filter((field) => !required.includes(field));
  return optional.length === 0 ? "(none)" : optional.join(", ");
}
