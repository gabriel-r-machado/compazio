import Database from "better-sqlite3";

export interface WorkflowNodePromptInput {
  readonly nodeId: string;
  readonly prompt: string;
}

/**
 * Durable prompt store for every official run, independent of creation mode. Prompts are written only
 * after the workflow run row exists and before the scheduler can launch its first node.
 */
export class SqliteWorkflowNodePromptStore {
  private readonly sqlite: Database.Database;

  public constructor(
    filename: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public putMany(runId: string, prompts: readonly WorkflowNodePromptInput[]): void {
    validateIdentifier(runId, "Workflow run id");
    const insert = this.sqlite.prepare(
      `INSERT INTO workflow_node_prompts (run_id, node_id, prompt, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, node_id) DO NOTHING`
    );
    const transaction = this.sqlite.transaction(() => {
      for (const entry of prompts) {
        validateIdentifier(entry.nodeId, "Workflow node id");
        const prompt = entry.prompt.trim();
        if (prompt.length === 0 || prompt.length > 20_000) {
          throw new Error("Workflow node prompt is empty or too large");
        }
        insert.run(runId, entry.nodeId, prompt, this.now().getTime());
      }
    });
    transaction();
  }

  public getNodePrompt(runId: string, nodeId: string): string | null {
    const row = this.sqlite
      .prepare("SELECT prompt FROM workflow_node_prompts WHERE run_id = ? AND node_id = ?")
      .get(runId, nodeId) as { readonly prompt: string } | undefined;
    return row?.prompt ?? null;
  }

  public close(): void {
    this.sqlite.close();
  }
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is invalid`);
}
