ALTER TABLE `workspace_artifact_events` ADD `projection_state` text NOT NULL DEFAULT 'published';--> statement-breakpoint
CREATE INDEX `workspace_artifact_events_projection_idx` ON `workspace_artifact_events` (`projection_state`,`created_at`);--> statement-breakpoint
INSERT INTO `canvas_nodes`
  (`canvas_id`, `id`, `type`, `position_x`, `position_y`, `width`, `height`, `data_json`)
SELECT
  `canvas_id`,
  'artifact-' || `id`,
  'artifact',
  160 + ((`ordinal` - 1) % 4) * 400,
  140 + ((`ordinal` - 1) / 4) * 260,
  360,
  180,
  json_object(
    'title', `filename`,
    'state', 'idle',
    'summary', 'Artefato publicado: ' || `kind` || ' (' || `byte_size` || ' B)',
    'artifact', json_object(
      'artifactId', `id`,
      'kind', `kind`,
      'relativePath', `relative_path`,
      'filename', `filename`,
      'sha256', `sha256`,
      'byteSize', `byte_size`,
      'mediaType', `media_type`
    ),
    'retryMaxAttempts', 1,
    'permissions', json('[]')
  )
FROM (
  SELECT
    w.`canvas_id`,
    a.`id`,
    a.`kind`,
    a.`relative_path`,
    a.`filename`,
    a.`sha256`,
    a.`byte_size`,
    a.`media_type`,
    row_number() OVER (PARTITION BY w.`canvas_id` ORDER BY a.`created_at`, a.`id`) AS `ordinal`
  FROM `workspace_artifacts` a
  JOIN `workspaces` w ON w.`id` = a.`workspace_id`
);--> statement-breakpoint
UPDATE `canvases`
SET `revision` = `revision` + 1
WHERE EXISTS (
  SELECT 1
  FROM `workspace_artifacts` a
  JOIN `workspaces` w ON w.`id` = a.`workspace_id`
  WHERE w.`canvas_id` = `canvases`.`id`
);
