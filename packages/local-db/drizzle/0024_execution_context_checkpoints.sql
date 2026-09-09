CREATE TABLE `execution_context_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `agent_node_id` text NOT NULL,
  `task` text NOT NULL,
  `contract_id` text,
  `payload_json` text NOT NULL,
  `sha256` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `execution_context_snapshots_workspace_agent_created_idx`
  ON `execution_context_snapshots` (`workspace_id`, `agent_node_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `execution_context_snapshots_contract_idx`
  ON `execution_context_snapshots` (`contract_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `execution_checkpoints` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `agent_node_id` text NOT NULL,
  `type` text NOT NULL,
  `task` text NOT NULL,
  `contract_id` text,
  `snapshot_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`snapshot_id`) REFERENCES `execution_context_snapshots`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `execution_checkpoints_workspace_agent_created_idx`
  ON `execution_checkpoints` (`workspace_id`, `agent_node_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `execution_checkpoints_snapshot_idx` ON `execution_checkpoints` (`snapshot_id`);
