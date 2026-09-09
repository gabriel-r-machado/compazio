CREATE TABLE `orchestration_proposals` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE RESTRICT,
  `status` text NOT NULL,
  `autonomy_level` text NOT NULL,
  `proposal_json` text NOT NULL,
  `checksum` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `approved_at` integer,
  `rejected_at` integer
);
--> statement-breakpoint
CREATE INDEX `orchestration_proposals_workspace_updated_idx` ON `orchestration_proposals` (`workspace_id`, `updated_at`);
