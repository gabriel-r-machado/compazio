-- Durable requests to close an agent's terminal or reassign its responsibility. The CLI cannot end a
-- PTY, so it records a request the desktop runtime claims and applies; persisting it also means a
-- request in flight when the app closes is recovered instead of silently lost.
CREATE TABLE agent_lifecycle_commands (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canvas_id text NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_node_id text NOT NULL,
  action text NOT NULL,
  role_json text,
  requested_by_node_id text,
  status text NOT NULL,
  idempotency_key text NOT NULL,
  session_id text REFERENCES runtime_sessions(id) ON DELETE SET NULL,
  error_code text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_lifecycle_commands_workspace_idempotency_idx
  ON agent_lifecycle_commands (workspace_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX agent_lifecycle_commands_delivery_idx
  ON agent_lifecycle_commands (status, created_at);
--> statement-breakpoint
CREATE TABLE agent_lifecycle_command_events (
  id text PRIMARY KEY,
  command_id text NOT NULL REFERENCES agent_lifecycle_commands(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  type text NOT NULL,
  payload_json text NOT NULL,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_lifecycle_command_events_sequence_idx
  ON agent_lifecycle_command_events (command_id, sequence);
