# Filesystem security

The renderer never receives direct `fs` access. All file operations go through `FileSystemService`
in the Electron main process and validated IPC boundaries.

- Inputs are always workspace-relative.
- Traversal, absolute paths, UNC paths and null bytes are rejected.
- Existing targets are resolved with `realpath`; symlinks and junctions that escape the workspace
  root are rejected.
- Text reads and previews have size limits.
- The editor accepts non-binary UTF-8 content.
- Writes use a temporary file followed by an atomic rename.
- A revision containing hash, size and mtime prevents overwriting an external change.
- Deleting the workspace root is forbidden and destructive operations require UI confirmation.

Runtime watchers are scoped per tree, debounced and cleaned up when the tree is closed or removed.
`.git`, `node_modules` and `.compazio` are excluded from lightweight search traversal.

## Importing files from the computer

Users can bring files from anywhere on the computer onto the canvas through the native file picker
or by dragging them from the operating-system file explorer. This does not weaken workspace path
containment for agents.

- The picker is opened by the main process and anchored to the workspace directory.
- A file already inside the workspace is referenced in place.
- A file outside the workspace is **copied** into `.compazio/anexos`; subsequent reads remain
  workspace-relative.
- Existing files are never overwritten; duplicate names receive a numeric suffix.
- Directories are rejected and each file is limited to 50 MB.
- The renderer never receives an absolute path: `importFiles` returns relative paths.

The real path of a dragged file comes from `webUtils.getPathForFile` in the preload. The renderer
has no access to `File.path` or `fs`.
