import type {
  AgentNodeLaunchInput,
  AgentNodeLaunchPlan,
  AgentNodeLaunchResolver
} from "./process-agent-node-executor";

const JSON_MEDIA_TYPE = "application/json";

/**
 * Launch resolver for the deterministic fake-agent adapter (`adapter: "fake-agent"`). It is the
 * only fake boundary in the vertical slice: it selects the fake-agent binary and the mode/args for
 * each agent role, so the real ProcessAgentNodeExecutor, ProcessSupervisor, artifact registry and
 * scheduler run unchanged. Real provider adapters will implement the same resolver contract.
 */
export function createFakeAgentLaunchResolver(
  fakeAgentPath: string,
  nodeExecutablePath: string = process.execPath
): AgentNodeLaunchResolver {
  const executable = { path: nodeExecutablePath, kind: "native" as const };
  return {
    resolve(input: AgentNodeLaunchInput): AgentNodeLaunchPlan | null {
      if (input.node.adapter !== "fake-agent") return null;
      switch (input.role) {
        case "planner":
        case "planner-flaky": {
          const args = [
            fakeAgentPath,
            "--mode",
            "plan",
            "--out",
            input.outputPath,
            "--objective",
            input.task
          ];
          if (input.role === "planner-flaky") {
            args.push("--fail-once", input.statePath);
          }
          return {
            executable,
            args,
            producesArtifact: true,
            artifactType: "agent-plan",
            artifactFilename: "plan.json",
            mediaType: JSON_MEDIA_TYPE
          };
        }
        // `implementer` is the draft role that materializes to a build/executor worker in the smoke.
        case "executor":
        case "implementer": {
          const plan = input.inputs[0];
          if (plan === undefined) return null;
          return {
            executable,
            args: [
              fakeAgentPath,
              "--mode",
              "build",
              "--plan",
              plan.path,
              "--out",
              input.outputPath
            ],
            producesArtifact: true,
            artifactType: "agent-build",
            artifactFilename: "build.json",
            mediaType: JSON_MEDIA_TYPE
          };
        }
        case "always-fail":
          return {
            executable,
            args: [fakeAgentPath, "--mode", "crash", "--exit-code", "17"],
            producesArtifact: false,
            artifactType: "agent-none",
            artifactFilename: "none.json",
            mediaType: JSON_MEDIA_TYPE
          };
        case "hang":
          return {
            executable,
            args: [fakeAgentPath, "--mode", "hang"],
            producesArtifact: false,
            artifactType: "agent-none",
            artifactFilename: "none.json",
            mediaType: JSON_MEDIA_TYPE
          };
        default:
          return null;
      }
    }
  };
}
