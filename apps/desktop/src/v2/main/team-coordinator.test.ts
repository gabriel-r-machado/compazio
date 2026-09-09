import { addTerminalNode, createWorkspace } from "@forgedeck/compazio-v2-domain";
import { describe, expect, it } from "vitest";

import {
  teamCapabilitiesForTerminal,
  teamMcpToolNames,
  teamToolsForCapabilities
} from "./team-coordinator";

describe("Compazio team MCP contract", () => {
  it("exposes the bounded Wave 5C surface to a Compazio and worker-safe tools to a recruit", () => {
    const dependencies = {
      createId: (() => {
        let counter = 0;
        return () => `team-contract-${++counter}`;
      })(),
      now: () => "2026-07-29T12:00:00.000Z"
    };
    let workspace = createWorkspace(
      { name: "Team contract", workingDirectory: "C:/tmp/team" },
      dependencies
    );
    workspace = addTerminalNode(
      workspace,
      { title: "Claude Compazio", isCompazio: true, agentConfig: { agentId: "claude-code" } },
      dependencies
    );
    const compazio = workspace.nodes.find((node) => node.type === "terminal" && node.isCompazio);
    if (compazio?.type !== "terminal") throw new Error("Compazio fixture missing");
    workspace = addTerminalNode(
      workspace,
      {
        title: "Codex recruit",
        agentConfig: { agentId: "codex" },
        orchestratorOwnerNodeId: compazio.id
      },
      dependencies
    );
    const worker = workspace.nodes.find(
      (node) => node.type === "terminal" && node.orchestratorOwnerNodeId === compazio.id
    );
    if (worker?.type !== "terminal") throw new Error("Worker fixture missing");

    expect(teamToolsForCapabilities(teamCapabilitiesForTerminal(workspace, compazio.id))).toEqual(
      teamMcpToolNames.filter((tool) => tool !== "task_request_user_input")
    );
    expect(teamToolsForCapabilities(teamCapabilitiesForTerminal(workspace, worker.id))).toEqual([
      "team_list",
      "team_status",
      "task_list",
      "task_status",
      "task_result",
      "task_request_user_input",
      "task_wait",
      "team_user_input_list",
      "message_send",
      "message_list",
      "message_read",
      "message_acknowledge"
    ]);
  });

  it("grants the same bounded team surface to a Codex Compazio", () => {
    const dependencies = {
      createId: (() => {
        let counter = 0;
        return () => `codex-team-contract-${++counter}`;
      })(),
      now: () => "2026-08-01T12:00:00.000Z"
    };
    let workspace = createWorkspace(
      { name: "Codex team contract", workingDirectory: "C:/tmp/codex-team" },
      dependencies
    );
    workspace = addTerminalNode(
      workspace,
      { title: "Codex Compazio", isCompazio: true, agentConfig: { agentId: "codex" } },
      dependencies
    );
    const compazio = workspace.nodes.find((node) => node.type === "terminal" && node.isCompazio);
    if (compazio?.type !== "terminal") throw new Error("Codex Compazio fixture missing");
    workspace = addTerminalNode(
      workspace,
      {
        title: "Claude recruit",
        agentConfig: { agentId: "claude-code" },
        orchestratorOwnerNodeId: compazio.id
      },
      dependencies
    );
    const worker = workspace.nodes.find(
      (node) => node.type === "terminal" && node.orchestratorOwnerNodeId === compazio.id
    );
    if (worker?.type !== "terminal") throw new Error("Claude worker fixture missing");

    expect(teamToolsForCapabilities(teamCapabilitiesForTerminal(workspace, compazio.id))).toEqual(
      teamMcpToolNames.filter((tool) => tool !== "task_request_user_input")
    );
    expect(teamToolsForCapabilities(teamCapabilitiesForTerminal(workspace, worker.id))).toEqual([
      "team_list",
      "team_status",
      "task_list",
      "task_status",
      "task_result",
      "task_request_user_input",
      "task_wait",
      "team_user_input_list",
      "message_send",
      "message_list",
      "message_read",
      "message_acknowledge"
    ]);
  });
});
