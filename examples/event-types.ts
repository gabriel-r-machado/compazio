export type RunEvent =
  | {
      type: "run.started";
      runId: string;
      timestamp: string;
      payload: { workflowId: string; workflowVersion: string };
    }
  | {
      type: "node.started";
      runId: string;
      nodeRunId: string;
      timestamp: string;
      payload: { nodeId: string; attempt: number };
    }
  | {
      type: "process.exited";
      runId: string;
      nodeRunId: string;
      timestamp: string;
      payload: { exitCode: number | null; signal: string | null };
    }
  | {
      type: "artifact.created";
      runId: string;
      nodeRunId: string;
      timestamp: string;
      payload: { artifactId: string; kind: string; relativePath: string };
    }
  | {
      type: "gate.completed";
      runId: string;
      nodeRunId: string;
      timestamp: string;
      payload: { command: string; exitCode: number; durationMs: number };
    };
