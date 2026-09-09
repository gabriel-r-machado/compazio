ALTER TABLE `workspace_connection_events` ADD `event_type` text NOT NULL DEFAULT 'connection_created';--> statement-breakpoint
ALTER TABLE `workspace_connection_events` ADD `actor_node_id` text;--> statement-breakpoint
ALTER TABLE `workspace_connection_events` ADD `canvas_revision` integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE INDEX `workspace_connection_events_edge_type_idx` ON `workspace_connection_events` (`canvas_id`,`edge_id`,`event_type`,`created_at`);--> statement-breakpoint
UPDATE `workspace_connection_events`
SET `canvas_revision` = (
  SELECT `revision` FROM `canvases` WHERE `canvases`.`id` = `workspace_connection_events`.`canvas_id`
)
WHERE `canvas_revision` = 0;--> statement-breakpoint
UPDATE `canvas_edges`
SET `contract_json` = json_set(`contract_json`, '$.kind', 'context')
WHERE EXISTS (
  SELECT 1
  FROM `canvas_nodes` source
  JOIN `canvas_nodes` target
    ON target.`canvas_id` = source.`canvas_id`
  WHERE source.`canvas_id` = `canvas_edges`.`canvas_id`
    AND source.`id` = `canvas_edges`.`source_node_id`
    AND target.`id` = `canvas_edges`.`target_node_id`
    AND source.`type` IN ('note', 'artifact')
    AND target.`type` IN ('agent', 'terminal')
);--> statement-breakpoint
UPDATE `workspace_connection_events`
SET `contract_json` = json_set(`contract_json`, '$.kind', 'context')
WHERE EXISTS (
  SELECT 1
  FROM `canvas_nodes` source
  JOIN `canvas_nodes` target
    ON target.`canvas_id` = source.`canvas_id`
  WHERE source.`canvas_id` = `workspace_connection_events`.`canvas_id`
    AND source.`id` = `workspace_connection_events`.`source_node_id`
    AND target.`id` = `workspace_connection_events`.`target_node_id`
    AND source.`type` IN ('note', 'artifact')
    AND target.`type` IN ('agent', 'terminal')
);
