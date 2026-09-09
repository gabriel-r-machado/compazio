CREATE TABLE artifact_feedback (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  artifact_id text NOT NULL,
  artifact_version integer NOT NULL,
  content text NOT NULL,
  created_by text NOT NULL,
  created_at integer NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (artifact_id) REFERENCES workspace_artifacts(id) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX artifact_feedback_workspace_artifact_version_created_idx
  ON artifact_feedback (workspace_id, artifact_id, artifact_version, created_at);
