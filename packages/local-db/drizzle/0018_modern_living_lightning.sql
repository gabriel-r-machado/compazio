CREATE TABLE `policy_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`canvas_id` text,
	`actor_node_id` text,
	`permission` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `policy_decisions_workspace_created_idx` ON `policy_decisions` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `policy_decisions_actor_created_idx` ON `policy_decisions` (`actor_node_id`,`created_at`);