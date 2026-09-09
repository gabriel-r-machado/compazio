CREATE TABLE `agent_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `node_id` text NOT NULL,
  `version` integer NOT NULL,
  `identity` text NOT NULL,
  `adapter_id` text NOT NULL,
  `responsibilities` text NOT NULL,
  `limits` text NOT NULL,
  `capabilities_json` text NOT NULL,
  `expected_deliverables_json` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_profiles_workspace_node_version_idx`
  ON `agent_profiles` (`workspace_id`, `node_id`, `version`);
--> statement-breakpoint
CREATE INDEX `agent_profiles_workspace_node_created_idx`
  ON `agent_profiles` (`workspace_id`, `node_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `missions` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `version` integer NOT NULL,
  `objective` text NOT NULL,
  `scope_json` text NOT NULL,
  `decisions_json` text NOT NULL,
  `constraints_json` text NOT NULL,
  `progress` text NOT NULL,
  `blockers_json` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `missions_workspace_version_idx` ON `missions` (`workspace_id`, `version`);
--> statement-breakpoint
CREATE INDEX `missions_workspace_created_idx` ON `missions` (`workspace_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `workspace_memories` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `version` integer NOT NULL,
  `stack_json` text NOT NULL,
  `architecture` text NOT NULL,
  `patterns_json` text NOT NULL,
  `commands_json` text NOT NULL,
  `conventions_json` text NOT NULL,
  `technical_decisions_json` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_memories_workspace_version_idx`
  ON `workspace_memories` (`workspace_id`, `version`);
--> statement-breakpoint
CREATE INDEX `workspace_memories_workspace_created_idx`
  ON `workspace_memories` (`workspace_id`, `created_at`);
