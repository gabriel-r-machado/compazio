CREATE TABLE `agent_endpoints` (
	`workspace_id` text NOT NULL,
	`canvas_id` text NOT NULL,
	`node_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`adapter_id` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `node_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `runtime_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canvas_id`,`node_id`) REFERENCES `canvas_nodes`(`canvas_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_endpoints_session_idx` ON `agent_endpoints` (`session_id`);--> statement-breakpoint
CREATE INDEX `agent_endpoints_state_idx` ON `agent_endpoints` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `agent_message_events` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `agent_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_message_events_sequence_idx` ON `agent_message_events` (`message_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `agent_message_events_message_idx` ON `agent_message_events` (`message_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`recipient_node_id` text NOT NULL,
	`sender_node_id` text,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`session_id` text,
	`adapter_id` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_messages_workspace_idempotency_idx` ON `agent_messages` (`workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `agent_messages_delivery_idx` ON `agent_messages` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_messages_recipient_idx` ON `agent_messages` (`workspace_id`,`recipient_node_id`,`created_at`);