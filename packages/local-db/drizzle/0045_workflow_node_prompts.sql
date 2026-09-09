CREATE TABLE workflow_node_prompts (
  run_id text NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  prompt text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (run_id, node_id)
);
--> statement-breakpoint
CREATE INDEX workflow_node_prompts_run_idx
  ON workflow_node_prompts (run_id);
