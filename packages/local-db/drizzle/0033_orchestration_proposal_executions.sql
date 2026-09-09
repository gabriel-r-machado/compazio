CREATE TABLE `orchestration_proposal_executions` (
  `proposal_id` text PRIMARY KEY NOT NULL REFERENCES `orchestration_proposals`(`id`) ON DELETE CASCADE,
  `workflow_command_id` text NOT NULL UNIQUE REFERENCES `workflow_run_commands`(`id`) ON DELETE RESTRICT,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `orchestration_proposal_executions_command_idx`
  ON `orchestration_proposal_executions` (`workflow_command_id`);
