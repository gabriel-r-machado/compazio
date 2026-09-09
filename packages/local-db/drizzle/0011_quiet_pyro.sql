CREATE TABLE `agent_spawn_events` (
	`id` text PRIMARY KEY NOT NULL,
	`spawn_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`spawn_id`) REFERENCES `agent_spawns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_spawn_events_sequence_idx` ON `agent_spawn_events` (`spawn_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `agent_spawn_events_spawn_idx` ON `agent_spawn_events` (`spawn_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_spawns` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`canvas_id` text NOT NULL,
	`project_id` text NOT NULL,
	`node_id` text NOT NULL,
	`adapter_id` text NOT NULL,
	`role_name` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`requested_by_node_id` text,
	`status` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`session_id` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `runtime_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_spawns_workspace_idempotency_idx` ON `agent_spawns` (`workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_spawns_workspace_name_idx` ON `agent_spawns` (`workspace_id`,`normalized_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_spawns_workspace_node_idx` ON `agent_spawns` (`workspace_id`,`node_id`);--> statement-breakpoint
CREATE INDEX `agent_spawns_status_idx` ON `agent_spawns` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_spawns_workspace_idx` ON `agent_spawns` (`workspace_id`,`created_at`);