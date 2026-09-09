import type { CanvasNodeData } from "@forgedeck/schemas";

import type { ForgeFlowNode } from "./canvas-store";

interface InspectorProps {
  readonly node: ForgeFlowNode | null;
  readonly onClose: () => void;
  readonly onUpdate: (patch: Partial<CanvasNodeData>) => void;
}

const permissionOptions = [
  "process",
  "workspace_read",
  "workspace_write",
  "network",
  "git_read",
  "git_write",
  "read_context",
  "connect_context",
  "destructive"
] as const;

export function Inspector({ node, onClose, onUpdate }: InspectorProps) {
  if (node === null) {
    return (
      <aside className="inspector" aria-label="Node inspector">
        <button
          className="inspector-close"
          aria-label="Close inspector"
          type="button"
          onClick={onClose}
        >
          ×
        </button>
        <p className="fd-eyebrow">Details</p>
        <h2>No node selected</h2>
        <p>Select a node to edit its details and access.</p>
      </aside>
    );
  }
  return (
    <aside className="inspector" aria-label="Node inspector">
      <button
        className="inspector-close"
        aria-label="Close inspector"
        type="button"
        onClick={onClose}
      >
        ×
      </button>
      <p className="fd-eyebrow">{node.type} details</p>
      <h2>{node.data.title}</h2>
      <label>
        Title
        <input
          value={node.data.title}
          onChange={(event) => onUpdate({ title: event.target.value || "Untitled node" })}
        />
      </label>
      <label>
        Summary
        <textarea
          rows={5}
          value={node.data.summary}
          onChange={(event) => onUpdate({ summary: event.target.value })}
        />
      </label>
      {node.type === "note" ? (
        <label>
          Note
          <textarea
            rows={8}
            value={node.data.content ?? ""}
            onChange={(event) => onUpdate({ content: event.target.value })}
          />
        </label>
      ) : null}
      <label>
        Retry attempts
        <input
          type="number"
          min={1}
          max={10}
          value={node.data.retryMaxAttempts}
          onChange={(event) =>
            onUpdate({
              retryMaxAttempts: Math.min(
                10,
                Math.max(1, Number.parseInt(event.target.value, 10) || 1)
              )
            })
          }
        />
      </label>
      <fieldset>
        <legend>Access requested</legend>
        {permissionOptions.map((permission) => (
          <label className="permission-option" key={permission}>
            <input
              type="checkbox"
              checked={node.data.permissions.includes(permission)}
              onChange={(event) =>
                onUpdate({
                  permissions: event.target.checked
                    ? [...node.data.permissions, permission]
                    : node.data.permissions.filter((entry) => entry !== permission)
                })
              }
            />
            {permissionLabel(permission)}
          </label>
        ))}
      </fieldset>
      <div className="inspector-meta">
        <span>State</span>
        <strong>{node.data.state}</strong>
        <span>Position</span>
        <strong>
          {Math.round(node.position.x)}, {Math.round(node.position.y)}
        </strong>
      </div>
    </aside>
  );
}

function permissionLabel(permission: (typeof permissionOptions)[number]): string {
  const labels: Record<(typeof permissionOptions)[number], string> = {
    process: "Run local processes",
    workspace_read: "Read workspace files",
    workspace_write: "Change workspace files",
    network: "Use the network",
    git_read: "Read Git status",
    git_write: "Change Git history",
    read_context: "Read connected context",
    connect_context: "Connect context to this agent",
    destructive: "Make destructive changes"
  };
  return labels[permission];
}
