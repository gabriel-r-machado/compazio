import { describe, expect, it } from "vitest";

import { canvasSnapshotSchema } from "./canvas";

describe("canvas IPC schema", () => {
  const node = {
    id: "node-1",
    type: "task",
    position: { x: 10, y: 20 },
    data: { title: "Task", state: "idle" }
  };

  it("accepts a bounded typed canvas snapshot", () => {
    const snapshot = canvasSnapshotSchema.parse({
      id: "default",
      title: "Default",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node],
      edges: []
    });
    expect(snapshot.nodes[0]?.data.retryMaxAttempts).toBe(1);
  });

  it("accepts optional orchestration roles and delivery contracts without breaking old canvases", () => {
    const snapshot = canvasSnapshotSchema.parse({
      id: "roles",
      title: "Role flow",
      mission: "Deliver a tested change",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          ...node,
          type: "agent",
          data: {
            ...node.data,
            role: {
              name: "Reviewer",
              responsibilities: "Review the implementation",
              constraints: "Do not modify files",
              expectedDeliverable: "Findings with evidence",
              completionCriteria: "Every finding has a reproduction"
            }
          }
        }
      ],
      edges: []
    });

    expect(snapshot.mission).toBe("Deliver a tested change");
    expect(snapshot.nodes[0]?.data.role?.name).toBe("Reviewer");
  });

  it("persists bounded progress and a local blocker without changing permissions", () => {
    const snapshot = canvasSnapshotSchema.parse({
      id: "progress",
      title: "Progress",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          ...node,
          data: {
            ...node.data,
            state: "blocked",
            progressPercent: 42,
            blocker: "Waiting for the reviewed design decision.",
            permissions: ["connect_context"]
          }
        }
      ],
      edges: []
    });

    expect(snapshot.nodes[0]?.data).toMatchObject({
      progressPercent: 42,
      blocker: "Waiting for the reviewed design decision.",
      permissions: ["connect_context"]
    });
  });

  it("rejects out-of-range progress and empty blockers", () => {
    const result = canvasSnapshotSchema.safeParse({
      id: "invalid-progress",
      title: "Invalid progress",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          ...node,
          data: { ...node.data, progressPercent: 101, blocker: "" }
        }
      ],
      edges: []
    });

    expect(result.success).toBe(false);
  });

  it("rejects self edges and missing endpoints", () => {
    const result = canvasSnapshotSchema.safeParse({
      id: "default",
      title: "Default",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node],
      edges: [
        {
          id: "bad",
          source: "node-1",
          target: "node-1",
          contract: { schemaVersion: "1.0", kind: "dependency" }
        }
      ]
    });
    expect(result.success).toBe(false);
  });

  it("accepts typed context sources only when their metadata matches the node type", () => {
    const result = canvasSnapshotSchema.safeParse({
      id: "context",
      title: "Context",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          ...node,
          type: "text",
          data: {
            ...node.data,
            contextSource: { kind: "text", content: "Reviewed decision." }
          }
        },
        {
          ...node,
          id: "link-1",
          type: "link",
          data: {
            ...node.data,
            contextSource: { kind: "link", url: "https://docs.example.com/guide" }
          }
        }
      ],
      edges: []
    });

    expect(result.success).toBe(true);
  });

  it("rejects untyped context nodes and unsafe link references", () => {
    const untyped = canvasSnapshotSchema.safeParse({
      id: "context",
      title: "Context",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{ ...node, type: "file" }],
      edges: []
    });
    const unsafeLink = canvasSnapshotSchema.safeParse({
      id: "context-link",
      title: "Context",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          ...node,
          type: "link",
          data: {
            ...node.data,
            contextSource: {
              kind: "link",
              url: "https://user:secret@example.com/guide?token=secret"
            }
          }
        }
      ],
      edges: []
    });

    expect(untyped.success).toBe(false);
    expect(unsafeLink.success).toBe(false);
  });

  it("accepts HTTPS links that carry a query string or fragment", () => {
    const result = canvasSnapshotSchema.safeParse({
      id: "context-link",
      title: "Context",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          ...node,
          type: "link",
          data: {
            ...node.data,
            contextSource: {
              kind: "link",
              url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=42"
            }
          }
        }
      ],
      edges: []
    });

    expect(result.success).toBe(true);
  });

  it("keeps an inline image preview but rejects previews on non-image sources", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgo=";
    const image = canvasSnapshotSchema.safeParse({
      id: "context-image",
      title: "Context",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          ...node,
          type: "image",
          data: {
            ...node.data,
            contextSource: {
              kind: "image",
              filename: "diagram.png",
              mediaType: "image/png",
              byteSize: 12,
              previewDataUri: dataUri
            }
          }
        }
      ],
      edges: []
    });
    const mismatched = canvasSnapshotSchema.safeParse({
      id: "context-file",
      title: "Context",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          ...node,
          type: "file",
          data: {
            ...node.data,
            contextSource: { kind: "file", filename: "notes.txt", previewDataUri: dataUri }
          }
        }
      ],
      edges: []
    });

    expect(image.success).toBe(true);
    expect(mismatched.success).toBe(false);
  });

  it("persists bounded visual shapes and frames with valid membership", () => {
    const result = canvasSnapshotSchema.safeParse({
      id: "visual",
      title: "Visual canvas",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        node,
        {
          ...node,
          id: "shape-1",
          type: "shape",
          zIndex: -1,
          data: { ...node.data, shape: { kind: "diamond" } }
        },
        {
          ...node,
          id: "frame-1",
          type: "frame",
          zIndex: -1,
          data: { ...node.data, frame: { memberNodeIds: ["node-1", "shape-1"] } }
        },
        {
          ...node,
          id: "comment-1",
          type: "comment",
          data: { ...node.data, content: "Local review annotation" }
        }
      ],
      edges: []
    });

    expect(result.success).toBe(true);
  });

  it("defaults the header controls and carries draft lifecycle/lock on a node", () => {
    const snapshot = canvasSnapshotSchema.parse({
      id: "controls",
      title: "Controls",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          ...node,
          type: "agent",
          data: {
            ...node.data,
            lifecycle: "draft",
            lock: { lockedByUser: true, lockedFields: ["title"] }
          }
        }
      ],
      edges: []
    });

    expect(snapshot.creationMode).toBe("manual");
    expect(snapshot.executionProfile).toBe("balanced");
    expect(snapshot.nodes[0]?.data.lifecycle).toBe("draft");
    expect(snapshot.nodes[0]?.data.lock?.lockedFields).toEqual(["title"]);
  });

  it("keeps an explicit automatic/economy header selection", () => {
    const snapshot = canvasSnapshotSchema.parse({
      id: "controls-explicit",
      title: "Controls",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      creationMode: "automatic",
      executionProfile: "economy",
      nodes: [node],
      edges: []
    });

    expect(snapshot.creationMode).toBe("automatic");
    expect(snapshot.executionProfile).toBe("economy");
  });

  it("rejects incomplete visual nodes and invalid frame membership", () => {
    const result = canvasSnapshotSchema.safeParse({
      id: "visual-invalid",
      title: "Visual canvas",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { ...node, type: "shape" },
        {
          ...node,
          id: "frame-1",
          type: "frame",
          data: { ...node.data, frame: { memberNodeIds: ["missing"] } }
        }
      ],
      edges: []
    });

    expect(result.success).toBe(false);
  });
});
