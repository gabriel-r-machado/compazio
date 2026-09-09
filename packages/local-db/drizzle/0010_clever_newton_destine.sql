CREATE TABLE `agent_message_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`request_message_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`responder_node_id` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`delivery_message_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_message_id`) REFERENCES `agent_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delivery_message_id`) REFERENCES `agent_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_message_responses_idempotency_idx` ON `agent_message_responses` (`request_message_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `agent_message_responses_workspace_idx` ON `agent_message_responses` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_message_responses_request_idx` ON `agent_message_responses` (`request_message_id`,`created_at`);