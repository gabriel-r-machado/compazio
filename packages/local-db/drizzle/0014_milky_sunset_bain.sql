CREATE TABLE `workspace_connection_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`canvas_id` text NOT NULL,
	`edge_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`contract_json` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`projection_state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_connection_events_idempotency_idx` ON `workspace_connection_events` (`workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `workspace_connection_events_projection_idx` ON `workspace_connection_events` (`projection_state`,`created_at`);--> statement-breakpoint
CREATE INDEX `workspace_connection_events_canvas_idx` ON `workspace_connection_events` (`canvas_id`,`created_at`);