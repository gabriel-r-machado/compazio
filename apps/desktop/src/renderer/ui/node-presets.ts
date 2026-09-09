import type { CanvasNodeData, CanvasNodeType } from "@forgedeck/schemas";

export interface AddNodePreset {
  readonly id:
    | "claude-code"
    | "codex"
    | "opencode"
    | "terminal"
    | "note"
    | "text"
    | "link"
    | "file"
    | "folder"
    | "image"
    | "drawing"
    | "page"
    | "rectangle"
    | "ellipse"
    | "diamond"
    | "frame"
    | "comment"
    | "files"
    | "preview"
    | "tests"
    | "approval"
    | "git-review";
  readonly label: string;
  readonly description: string;
  readonly nodeType: CanvasNodeType;
  readonly data: CanvasNodeData;
}

export const addNodePresets: readonly AddNodePreset[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Start a Claude Code session in this workspace.",
    nodeType: "agent",
    data: nodeData("Claude Code", "Ready to connect to this workspace.", "claude-code")
  },
  {
    id: "codex",
    label: "Codex",
    description: "Start a Codex CLI session in this workspace.",
    nodeType: "agent",
    data: nodeData("Codex", "Ready to connect to this workspace.", "codex")
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "Add an OpenCode session when its adapter is installed.",
    nodeType: "agent",
    data: nodeData("OpenCode", "Adapter availability is checked before connecting.", "opencode")
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "Open an interactive local terminal.",
    nodeType: "terminal",
    data: nodeData("Terminal", "Ready to connect to this workspace.", "shell")
  },
  {
    id: "note",
    label: "Note",
    description: "Keep a decision or handoff close to the work.",
    nodeType: "note",
    data: {
      ...nodeData("Note", "Write a decision, context, or handoff."),
      content: ""
    }
  },
  {
    id: "text",
    label: "Text source",
    description: "Keep bounded text available only through an explicit context connection.",
    nodeType: "text",
    data: contextNodeData("text", "Text source", "Add reviewed text context.", "")
  },
  {
    id: "link",
    label: "Link source",
    description: "Record a credential-free HTTPS reference without fetching it automatically.",
    nodeType: "link",
    data: contextNodeData("link", "Link source", "Add an HTTPS link in the inspector.")
  },
  {
    id: "file",
    label: "File source",
    description: "Reserve a managed file reference without exposing its local path.",
    nodeType: "file",
    data: contextNodeData(
      "file",
      "File source",
      "Managed file metadata is available through context."
    )
  },
  {
    id: "folder",
    label: "Folder source",
    description: "Reserve a managed folder reference without exposing its local path.",
    nodeType: "folder",
    data: contextNodeData(
      "folder",
      "Folder source",
      "Managed folder metadata is available through context."
    )
  },
  {
    id: "image",
    label: "Image source",
    description: "Keep image metadata available through an explicit context connection.",
    nodeType: "image",
    data: contextNodeData(
      "image",
      "Image source",
      "Managed image metadata is available through context."
    )
  },
  {
    id: "drawing",
    label: "Drawing source",
    description: "Keep a lightweight drawing description as local context.",
    nodeType: "drawing",
    data: contextNodeData("drawing", "Drawing source", "Describe the diagram or drawing.", "")
  },
  {
    id: "page",
    label: "Page source",
    description: "Keep a local page of reviewed context.",
    nodeType: "page",
    data: contextNodeData("page", "Page source", "Write the reviewed page context.", "")
  },
  {
    id: "rectangle",
    label: "Rectangle",
    description: "Add a non-executable visual shape to explain the canvas.",
    nodeType: "shape",
    data: shapeNodeData("rectangle", "Rectangle", "Visual annotation")
  },
  {
    id: "ellipse",
    label: "Ellipse",
    description: "Add a non-executable visual shape to explain the canvas.",
    nodeType: "shape",
    data: shapeNodeData("ellipse", "Ellipse", "Visual annotation")
  },
  {
    id: "diamond",
    label: "Diamond",
    description: "Add a non-executable visual shape to explain the canvas.",
    nodeType: "shape",
    data: shapeNodeData("diamond", "Diamond", "Decision or visual annotation")
  },
  {
    id: "frame",
    label: "Frame",
    description: "Create a visual group without changing runtime dependencies.",
    nodeType: "frame",
    data: frameNodeData("Frame", "Visual group")
  },
  {
    id: "comment",
    label: "Comment",
    description: "Keep a local visual annotation without exposing it as agent context.",
    nodeType: "comment",
    data: {
      ...nodeData("Comment", "Add a local annotation."),
      content: ""
    }
  },
  {
    id: "files",
    label: "Files",
    description: "Track the files relevant to this piece of work.",
    nodeType: "task",
    data: nodeData("Files", "Add the files to inspect in this workspace.")
  },
  {
    id: "preview",
    label: "Preview",
    description: "Reserve a visual review step for this workspace.",
    nodeType: "task",
    data: nodeData("Preview", "Preview is ready when the work produces one.")
  },
  {
    id: "tests",
    label: "Tests",
    description: "Track test evidence before completing the work.",
    nodeType: "task",
    data: nodeData("Tests", "Evidence is required before completion.")
  },
  {
    id: "approval",
    label: "Approval",
    description: "Pause for a human decision before continuing.",
    nodeType: "gate",
    data: {
      ...nodeData("Approval", "A person must approve this step before it continues."),
      state: "blocked"
    }
  },
  {
    id: "git-review",
    label: "Git review",
    description: "Review the local diff and recorded quality evidence.",
    nodeType: "task",
    data: nodeData("Git review", "Inspect the worktree diff before a human-confirmed merge.")
  }
];

const quickAddKinds: readonly AddNodePreset["id"][] = [
  "terminal",
  "claude-code",
  "codex",
  "opencode",
  "note",
  "text",
  "link",
  "comment"
];

export const quickAddNodePresets: readonly AddNodePreset[] = quickAddKinds.map((kind) =>
  getAddNodePreset(kind)
);

export type AddNodeKind = AddNodePreset["id"];

export function getAddNodePreset(kind: AddNodeKind): AddNodePreset {
  const preset = addNodePresets.find((entry) => entry.id === kind);
  if (preset === undefined) {
    throw new Error(`Unknown canvas node preset: ${kind}`);
  }
  return preset;
}

function nodeData(title: string, summary: string, adapterId?: string): CanvasNodeData {
  return {
    title,
    state: "idle",
    summary,
    ...(adapterId === undefined ? {} : { adapterId }),
    retryMaxAttempts: 1,
    permissions: []
  };
}

function contextNodeData(
  kind: Extract<CanvasNodeType, "text" | "link" | "file" | "folder" | "image" | "drawing" | "page">,
  title: string,
  summary: string,
  content?: string
): CanvasNodeData {
  return {
    ...nodeData(title, summary),
    contextSource: {
      kind,
      ...(content === undefined ? {} : { content })
    }
  };
}

function shapeNodeData(
  kind: "rectangle" | "ellipse" | "diamond",
  title: string,
  summary: string
): CanvasNodeData {
  return {
    ...nodeData(title, summary),
    shape: { kind }
  };
}

function frameNodeData(title: string, summary: string): CanvasNodeData {
  return {
    ...nodeData(title, summary),
    frame: { memberNodeIds: [] }
  };
}
