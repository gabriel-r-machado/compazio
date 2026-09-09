CREATE TABLE `artifact_memories` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `artifact_id` text NOT NULL,
  `version` integer NOT NULL,
  `origin` text NOT NULL,
  `sha256` text NOT NULL,
  `relationships_json` text NOT NULL,
  `relevance` text NOT NULL,
  `status` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`artifact_id`) REFERENCES `workspace_artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_memories_workspace_artifact_version_idx`
  ON `artifact_memories` (`workspace_id`, `artifact_id`, `version`);
--> statement-breakpoint
CREATE INDEX `artifact_memories_workspace_artifact_created_idx`
  ON `artifact_memories` (`workspace_id`, `artifact_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `delivery_contracts` (
  `id` text PRIMARY KEY NOT NULL,
  `contract_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `source_node_id` text NOT NULL,
  `target_node_id` text NOT NULL,
  `version` integer NOT NULL,
  `inputs_json` text NOT NULL,
  `outputs_json` text NOT NULL,
  `completion_criteria_json` text NOT NULL,
  `declared_evidence_json` text NOT NULL,
  `verified_evidence_json` text NOT NULL,
  `state` text NOT NULL,
  `limits_json` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_contracts_route_version_idx`
  ON `delivery_contracts` (`workspace_id`, `source_node_id`, `target_node_id`, `contract_id`, `version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_contracts_contract_version_idx`
  ON `delivery_contracts` (`contract_id`, `version`);
--> statement-breakpoint
CREATE INDEX `delivery_contracts_workspace_created_idx`
  ON `delivery_contracts` (`workspace_id`, `created_at`);
