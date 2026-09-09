ALTER TABLE `orchestration_proposals` ADD COLUMN `revision` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `orchestration_proposals` ADD COLUMN `created_by` text NOT NULL DEFAULT 'local-user';
--> statement-breakpoint
ALTER TABLE `orchestration_proposals` ADD COLUMN `reviewed_by` text;
--> statement-breakpoint
CREATE TABLE `orchestration_proposal_events` (
  `id` text PRIMARY KEY NOT NULL,
  `proposal_id` text NOT NULL REFERENCES `orchestration_proposals`(`id`) ON DELETE CASCADE,
  `sequence` integer NOT NULL,
  `type` text NOT NULL,
  `actor` text NOT NULL,
  `details_json` text,
  `created_at` integer NOT NULL,
  UNIQUE(`proposal_id`, `sequence`)
);
--> statement-breakpoint
CREATE INDEX `orchestration_proposal_events_proposal_created_idx` ON `orchestration_proposal_events` (`proposal_id`, `created_at`);
