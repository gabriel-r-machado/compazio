CREATE TABLE context_source_indexes (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_node_id text NOT NULL,
  type text NOT NULL,
  origin text NOT NULL,
  version integer NOT NULL,
  source_sha256 text NOT NULL,
  byte_size integer NOT NULL,
  inclusion text NOT NULL,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX context_source_indexes_workspace_source_hash_idx
  ON context_source_indexes (workspace_id, source_node_id, source_sha256);
--> statement-breakpoint
CREATE UNIQUE INDEX context_source_indexes_workspace_source_version_idx
  ON context_source_indexes (workspace_id, source_node_id, version);
--> statement-breakpoint
CREATE INDEX context_source_indexes_workspace_created_idx
  ON context_source_indexes (workspace_id, created_at);
--> statement-breakpoint

CREATE TABLE context_index_chunks (
  id text PRIMARY KEY NOT NULL,
  index_id text NOT NULL REFERENCES context_source_indexes(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  sha256 text NOT NULL,
  byte_size integer NOT NULL,
  estimated_tokens integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX context_index_chunks_index_ordinal_idx
  ON context_index_chunks (index_id, ordinal);
--> statement-breakpoint
CREATE INDEX context_index_chunks_index_idx ON context_index_chunks (index_id);
--> statement-breakpoint

CREATE TABLE context_selection_caches (
  cache_key text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_node_id text NOT NULL,
  mode text NOT NULL,
  source_index_sha256 text NOT NULL,
  selection_json text NOT NULL,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX context_selection_caches_workspace_agent_created_idx
  ON context_selection_caches (workspace_id, agent_node_id, created_at);
--> statement-breakpoint

ALTER TABLE workflow_run_commands ADD COLUMN context_mode text;
