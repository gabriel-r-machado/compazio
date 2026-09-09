CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`node_run_id` text NOT NULL,
	`state` text NOT NULL,
	`decision_note` text,
	`requested_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_run_node_idx` ON `approvals` (`run_id`,`node_run_id`);--> statement-breakpoint
CREATE INDEX `approvals_state_idx` ON `approvals` (`state`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`node_run_id` text,
	`type` text NOT NULL,
	`relative_path` text NOT NULL,
	`sha256` text NOT NULL,
	`media_type` text NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifacts_run_idx` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `canvas_edges` (
	`canvas_id` text NOT NULL,
	`id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`contract_json` text NOT NULL,
	PRIMARY KEY(`canvas_id`, `id`),
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canvas_id`,`source_node_id`) REFERENCES `canvas_nodes`(`canvas_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canvas_id`,`target_node_id`) REFERENCES `canvas_nodes`(`canvas_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `canvas_edges_canvas_idx` ON `canvas_edges` (`canvas_id`);--> statement-breakpoint
CREATE TABLE `canvas_nodes` (
	`canvas_id` text NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`position_x` real NOT NULL,
	`position_y` real NOT NULL,
	`width` real,
	`height` real,
	`data_json` text NOT NULL,
	PRIMARY KEY(`canvas_id`, `id`),
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `canvas_nodes_canvas_idx` ON `canvas_nodes` (`canvas_id`);--> statement-breakpoint
CREATE TABLE `canvases` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`viewport_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`from_node_run_id` text NOT NULL,
	`to_node_run_id` text NOT NULL,
	`handoff_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `handoffs_run_idx` ON `handoffs` (`run_id`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`node_run_id` text,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`timestamp` integer NOT NULL,
	`schema_version` text NOT NULL,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_run_sequence_idx` ON `run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `run_events_node_idx` ON `run_events` (`node_run_id`);--> statement-breakpoint
CREATE TABLE `workflow_definitions` (
	`id` text NOT NULL,
	`version` text NOT NULL,
	`name` text NOT NULL,
	`definition_json` text NOT NULL,
	`definition_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `workflow_node_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`state` text NOT NULL,
	`attempt` integer NOT NULL,
	`input_hash` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`evidence_json` text NOT NULL,
	`failure_reason` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_node_runs_run_node_idx` ON `workflow_node_runs` (`run_id`,`node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_node_runs_idempotency_idx` ON `workflow_node_runs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `workflow_node_runs_state_idx` ON `workflow_node_runs` (`run_id`,`state`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_version` text NOT NULL,
	`workflow_hash` text NOT NULL,
	`input_hash` text NOT NULL,
	`workflow_snapshot_json` text NOT NULL,
	`effective_permissions_json` text NOT NULL,
	`state` text NOT NULL,
	`dry_run` integer NOT NULL,
	`concurrency` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`report_artifact_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_state_idx` ON `workflow_runs` (`state`);--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow_idx` ON `workflow_runs` (`workflow_id`);
