INSERT INTO artifact_memories (
  id,
  workspace_id,
  artifact_id,
  version,
  origin,
  sha256,
  relationships_json,
  relevance,
  status,
  created_by,
  created_at
)
SELECT
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-' ||
  lower(hex(randomblob(2))) || '-' ||
  lower(hex(randomblob(2))) || '-' ||
  lower(hex(randomblob(6))),
  artifacts.workspace_id,
  artifacts.id,
  1,
  artifacts.source_relative_path,
  artifacts.sha256,
  '[]',
  'relevant',
  'active',
  COALESCE(artifacts.published_by_node_id, 'local-user'),
  artifacts.created_at
FROM workspace_artifacts AS artifacts
WHERE NOT EXISTS (
  SELECT 1
  FROM artifact_memories AS memories
  WHERE memories.workspace_id = artifacts.workspace_id
    AND memories.artifact_id = artifacts.id
);
