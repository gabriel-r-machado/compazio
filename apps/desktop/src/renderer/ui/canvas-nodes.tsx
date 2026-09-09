import { memo, useCallback, useEffect, useRef, useState } from "react";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Handle, NodeResizer, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import type { CanvasContextSource, CanvasNodeData, TerminalEvent } from "@forgedeck/schemas";
import { canvasContextSourceSchema } from "@forgedeck/schemas";

import { AttachmentTooLargeError, importContextFile } from "./context-file-import";
import { formatByteSize } from "./byte-size";
import { useCanvasStore } from "./canvas-store";
import type { ForgeFlowNode } from "./canvas-store";
import { isTerminalBackedNode } from "./node-terminal";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { useTerminalNodeContext } from "./terminal-node-context";
import { useTheme } from "./theme";
import type { ProjectedCanvasNode } from "./workflow-run-projection";
import { useNodeRunOverlay } from "./workflow-run-node-context";

function CanvasNodeView({ data, id, type, selected }: NodeProps<ForgeFlowNode>) {
  const { t } = useI18n();
  const runOverlay = useNodeRunOverlay(id);
  const resolvedType = type ?? "task";
  const typeLabel = t(typeTranslationKeys[resolvedType]);
  if (isTerminalBackedNode(resolvedType, data.adapterId)) {
    return <TerminalNodeView data={data} id={id} selected={selected} type={resolvedType} />;
  }
  const isVisualOnly = resolvedType === "shape" || resolvedType === "frame";
  const isResizable =
    resolvedType === "note" ||
    resolvedType === "comment" ||
    resolvedType === "shape" ||
    resolvedType === "frame" ||
    data.contextSource !== undefined;
  return (
    <article
      className={`flow-node flow-node-${resolvedType}${
        data.shape === undefined ? "" : ` flow-node-shape-${data.shape.kind}`
      }${isResizable ? " flow-node-resizable" : ""}${selected ? " is-selected" : ""}${
        data.lifecycle === undefined ? "" : ` flow-node-lifecycle-${data.lifecycle}`
      }${runNodeClass(runOverlay)}`}
      aria-label={`${typeLabel}: ${data.title}`}
      data-testid={`canvas-node-${id}`}
      {...runNodeDomAttributes(runOverlay)}
    >
      {isResizable ? (
        <NodeResizer
          color={resolvedType === "frame" ? "#718096" : "#d7b86f"}
          handleClassName="node-resize-handle"
          isVisible={selected}
          lineClassName="node-resize-line"
          maxHeight={1_200}
          maxWidth={1_200}
          minHeight={140}
          minWidth={220}
        />
      ) : null}
      {isVisualOnly ? null : (
        <Handle
          className="node-connect-rail node-connect-rail-target"
          data-testid={`node-input-handle-${id}`}
          type="target"
          position={Position.Left}
          aria-label={t("node.input")}
          title={t("node.connectHere")}
        />
      )}
      <header>
        <span className="node-type">
          <Icon name={nodeTypeIcons[resolvedType]} />
          {typeLabel}
        </span>
        {data.lifecycle === "draft" || data.lifecycle === "configured" ? (
          <span className="node-draft-badge" title={t("composer.auto")}>
            {data.lock?.lockedByUser === true ? `● ${t("composer.locked")}` : t("composer.auto")}
          </span>
        ) : runOverlay !== undefined ? (
          <NodeRunBadge node={runOverlay} />
        ) : (
          <span className={`node-state node-state-${data.state}`}>
            {t(stateTranslationKeys[data.state])}
          </span>
        )}
      </header>
      <h3>{data.title}</h3>
      <NodeBody data={data} id={id} type={resolvedType} />
      <NodeAgentBadge data={data} />
      <NodeStatusDetails data={data} />
      {resolvedType === "artifact" && data.artifact !== undefined ? (
        <small>
          {data.artifact.relativePath}
          <br />
          SHA-256: {data.artifact.sha256.slice(0, 12)}…
        </small>
      ) : null}
      {resolvedType === "agent" && data.adapterId !== undefined ? (
        <small>{t("node.adapter", { adapter: data.adapterId })}</small>
      ) : null}
      {resolvedType === "gate" ? <small>{t("node.evidence")}</small> : null}
      {data.contextSource !== undefined ? <small>Direct context connection required</small> : null}
      {isContextPolicyNode(resolvedType) ? (
        <small>Context policy: {data.contextInclusion ?? "relevant"}</small>
      ) : null}
      {resolvedType === "frame" ? (
        <small>{data.frame?.memberNodeIds.length ?? 0} grouped items</small>
      ) : null}
      <NodePermissionSummary data={data} />
      {isVisualOnly ? null : (
        <Handle
          className="node-connect-rail node-connect-rail-source"
          data-testid={`node-output-handle-${id}`}
          type="source"
          position={Position.Right}
          aria-label={t("node.output")}
          title={t("node.dragToConnect")}
        />
      )}
    </article>
  );
}

function NodeBody({
  data,
  id,
  type
}: {
  readonly data: CanvasNodeData;
  readonly id: string;
  readonly type: NonNullable<ForgeFlowNode["type"]>;
}) {
  const { t } = useI18n();
  if (type === "note" || type === "comment") {
    return (
      <EditableNoteContent
        id={id}
        value={data.content ?? data.summary}
        placeholder={t(type === "note" ? "source.textPlaceholder" : "source.commentPlaceholder")}
      />
    );
  }
  const source = data.contextSource;
  if (source === undefined) {
    return <p>{data.summary}</p>;
  }
  if (source.kind === "text" || source.kind === "drawing" || source.kind === "page") {
    return (
      <EditableContextText
        id={id}
        source={source}
        value={source.content ?? ""}
        placeholder={t("source.textPlaceholder")}
      />
    );
  }
  if (source.kind === "link") {
    return <LinkSourceEditor id={id} source={source} />;
  }
  return <AttachmentSource id={id} kind={source.kind} source={source} />;
}

function EditableNoteContent({
  id,
  value,
  placeholder
}: {
  readonly id: string;
  readonly value: string;
  readonly placeholder: string;
}) {
  const updateNode = useCanvasStore((state) => state.updateNode);
  const [draft, setDraft] = useState(value);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (document.activeElement !== editor.current) {
      setDraft(value);
    }
  }, [value]);

  const commit = useCallback(() => {
    if (draft !== value) {
      updateNode(id, { content: draft, state: "idle" });
    }
  }, [draft, id, updateNode, value]);

  return (
    <textarea
      aria-label={placeholder}
      className="note-content-editor nodrag nopan nowheel"
      maxLength={20_000}
      placeholder={placeholder}
      ref={editor}
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function EditableContextText({
  id,
  source,
  value,
  placeholder
}: {
  readonly id: string;
  readonly source: CanvasContextSource;
  readonly value: string;
  readonly placeholder: string;
}) {
  const updateNode = useCanvasStore((state) => state.updateNode);
  const [draft, setDraft] = useState(value);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (document.activeElement !== editor.current) {
      setDraft(value);
    }
  }, [value]);

  const commit = useCallback(() => {
    if (draft !== value) {
      updateNode(id, { contextSource: { ...source, content: draft }, state: "idle" });
    }
  }, [draft, id, source, updateNode, value]);

  return (
    <textarea
      aria-label={placeholder}
      className="note-content-editor nodrag nopan nowheel"
      maxLength={100_000}
      placeholder={placeholder}
      ref={editor}
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function LinkSourceEditor({
  id,
  source
}: {
  readonly id: string;
  readonly source: CanvasContextSource;
}) {
  const { t } = useI18n();
  const updateNode = useCanvasStore((state) => state.updateNode);
  const value = source.url ?? "";
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== input.current) {
      setDraft(value);
    }
  }, [value]);

  const commit = useCallback(() => {
    const next = draft.trim();
    if (next === value) {
      setError(null);
      return;
    }
    if (next === "") {
      updateNode(id, { contextSource: { ...source, url: undefined }, state: "idle" });
      setError(null);
      return;
    }
    const parsed = canvasContextSourceSchema.safeParse({ ...source, url: next });
    if (!parsed.success) {
      setError(t("source.invalidLink"));
      return;
    }
    setError(null);
    updateNode(id, { contextSource: parsed.data, state: "idle" });
  }, [draft, id, source, t, updateNode, value]);

  const host = safeHost(value);
  return (
    <div className="link-source-editor nodrag">
      <input
        aria-label={t("source.linkLabel")}
        className="link-source-input nopan"
        inputMode="url"
        maxLength={2_048}
        placeholder={t("source.linkPlaceholder")}
        ref={input}
        type="url"
        value={draft}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {error !== null ? (
        <small className="context-source-error" role="alert">
          {error}
        </small>
      ) : host !== null ? (
        <a
          className="link-source-open"
          href={value}
          rel="noreferrer noopener"
          target="_blank"
          title={t("source.linkOpen")}
        >
          {host}
        </a>
      ) : null}
    </div>
  );
}

function AttachmentSource({
  id,
  kind,
  source
}: {
  readonly id: string;
  readonly kind: CanvasContextSource["kind"];
  readonly source: CanvasContextSource;
}) {
  const { t } = useI18n();
  const updateNode = useCanvasStore((state) => state.updateNode);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const hasFile = source.filename !== undefined;

  const onPick = useCallback(
    async (file: File | undefined) => {
      if (file === undefined) {
        return;
      }
      setError(null);
      try {
        const imported = await importContextFile(file);
        updateNode(id, {
          title: imported.title,
          contextSource: {
            kind,
            filename: imported.source.filename,
            mediaType: imported.source.mediaType,
            byteSize: imported.source.byteSize,
            sha256: imported.source.sha256,
            ...(kind === "image" && imported.source.previewDataUri !== undefined
              ? { previewDataUri: imported.source.previewDataUri }
              : {})
          },
          state: "idle"
        });
      } catch (importError) {
        setError(
          importError instanceof AttachmentTooLargeError
            ? t("canvas.fileTooLarge", { max: formatByteSize(importError.maxBytes) })
            : t("canvas.importFailed")
        );
      }
    },
    [id, kind, t, updateNode]
  );

  return (
    <div className="attachment-source nodrag">
      {source.previewDataUri !== undefined ? (
        <img
          alt={t("source.imageAlt", { name: source.filename ?? "" })}
          className="attachment-preview"
          src={source.previewDataUri}
        />
      ) : null}
      {hasFile ? (
        <div className="attachment-meta">
          <Icon name={kind === "image" ? "canvas" : "artifact"} />
          <span className="attachment-filename">{source.filename}</span>
          {source.byteSize === undefined ? null : <small>{formatByteSize(source.byteSize)}</small>}
        </div>
      ) : (
        <p className="attachment-empty">{t("source.attachmentEmpty")}</p>
      )}
      {error !== null ? (
        <small className="context-source-error" role="alert">
          {error}
        </small>
      ) : null}
      <button
        type="button"
        className="attachment-pick nopan"
        onClick={() => input.current?.click()}
      >
        <Icon name="artifact" />
        {hasFile
          ? t("source.replaceFile")
          : t(kind === "image" ? "source.addImage" : "source.addFile")}
      </button>
      <input
        accept={kind === "image" ? "image/*" : undefined}
        className="attachment-file-input"
        hidden
        ref={input}
        type="file"
        onChange={(event) => {
          void onPick(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </div>
  );
}

function safeHost(url: string): string | null {
  if (url === "") {
    return null;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function TerminalNodeView({
  data,
  id,
  selected,
  type
}: Pick<NodeProps<ForgeFlowNode>, "data" | "selected" | "type"> & { readonly id: string }) {
  const { t } = useI18n();
  const terminal = useTerminalNodeContext();
  const runOverlay = useNodeRunOverlay(id);
  const session = terminal.sessionsByNode[id];
  const error = terminal.errorsByNode[id];
  const isStarting = terminal.startingNodeIds.has(id);
  const isOutputActive = terminal.activeNodeIds.has(id);
  const canInterrupt =
    session !== undefined && ["starting", "running", "waiting", "stopping"].includes(session.state);
  const terminalLabel = t(type === "agent" ? "node.agentTerminal" : "node.terminal");
  const visualState =
    session?.state ?? (isStarting ? "starting" : error === undefined ? "ready" : "unavailable");

  return (
    <article
      className={`flow-node flow-node-terminal${type === "agent" ? " flow-node-agent-terminal" : ""}${
        selected ? " is-selected" : ""
      }${isOutputActive ? " is-output-active" : ""}${runNodeClass(runOverlay)}`}
      aria-label={`${terminalLabel}: ${data.title}`}
      data-testid={`canvas-node-${id}`}
      {...runNodeDomAttributes(runOverlay)}
    >
      <NodeResizer
        color="#72d7b2"
        handleClassName="node-resize-handle"
        isVisible={selected}
        lineClassName="node-resize-line"
        minHeight={300}
        minWidth={480}
      />
      <Handle
        className="node-connect-rail node-connect-rail-target"
        data-testid={`node-input-handle-${id}`}
        type="target"
        position={Position.Left}
        aria-label={t("node.input")}
        title={t("node.connectHere")}
      />
      <header className="terminal-titlebar">
        <div>
          <Icon name={type === "agent" ? "agent" : "terminal"} />
          <strong>{data.title}</strong>
          <small>{data.role?.name ?? terminalLabel}</small>
        </div>
        <div className="terminal-header-actions nodrag">
          {runOverlay === undefined ? null : <NodeRunBadge node={runOverlay} />}
          <span className={`node-state node-state-${session?.state ?? data.state}`}>
            {t(stateTranslationKeys[visualState])}
          </span>
          <details className="terminal-menu">
            <summary
              aria-label={t("terminal.actionsFor", { title: data.title })}
              title={t("terminal.actions")}
            >
              <Icon name="more" />
            </summary>
            <div>
              {canInterrupt && session !== undefined ? (
                <button type="button" onClick={() => terminal.interruptSession(id, session.id)}>
                  {t("terminal.stop")}
                </button>
              ) : session !== undefined ? (
                <button type="button" onClick={() => terminal.connectNode(id, data.adapterId)}>
                  {t("terminal.restart")}
                </button>
              ) : null}
            </div>
          </details>
        </div>
      </header>
      {session === undefined ? (
        <div className="terminal-starting">
          {isStarting ? <span className="terminal-spinner" aria-hidden="true" /> : null}
          <p>{isStarting ? t("terminal.starting") : data.summary}</p>
          {!isStarting ? (
            <button type="button" onClick={() => terminal.connectNode(id, data.adapterId)}>
              {error === undefined ? t("terminal.start") : t("terminal.tryAgain")}
            </button>
          ) : null}
        </div>
      ) : (
        <TerminalViewport
          clearEpoch={terminal.clearEpochsByNode[id] ?? 0}
          nodeId={id}
          sessionId={session.id}
        />
      )}
      {error === undefined ? null : (
        <div className="terminal-error" role="alert">
          <strong>{t("terminal.actionRequired")}</strong>
          <span>{error}</span>
        </div>
      )}
      <NodeStatusDetails data={data} />
      <NodePermissionSummary data={data} />
      <footer className="terminal-statusbar">
        <span>
          <i aria-hidden="true" />
          {data.adapterId ?? "shell"}
        </span>
        <small>{t(stateTranslationKeys[visualState])}</small>
      </footer>
      <Handle
        className="node-connect-rail node-connect-rail-source"
        data-testid={`node-output-handle-${id}`}
        type="source"
        position={Position.Right}
        aria-label={t("node.output")}
        title={t("node.dragToConnect")}
      />
    </article>
  );
}

/**
 * The official workflow-run status for a real node, projected from the runtime snapshot. It is a
 * separate axis from a terminal's live PTY state: the PTY chip stays visible for interaction while
 * this reflects what the deterministic scheduler says. A restart-recovered node is surfaced distinctly
 * because it needs a human decision (spec §18.4/§19.2).
 */
function NodeRunBadge({ node }: { readonly node: ProjectedCanvasNode }) {
  const { t } = useI18n();
  const label = node.isRecovered
    ? t("runState.recovered")
    : t(runStateTranslationKeys[node.runtimeState]);
  return (
    <span
      className={`node-run-state node-run-state-${node.runtimeState}${
        node.isRecovered ? " is-recovered" : ""
      }`}
      title={node.shortError ?? undefined}
      data-testid="node-run-state"
    >
      {label}
      {node.attempt > 1 ? ` ·${node.attempt}` : ""}
    </span>
  );
}

/** Colour/pulse modifier applied to the node article when an official run drives it. */
function runNodeClass(node: ProjectedCanvasNode | undefined): string {
  if (node === undefined) {
    return "";
  }
  return ` flow-node-run flow-node-run-${node.runtimeState}${
    node.isRecovered ? " flow-node-run-recovered" : ""
  }`;
}

/** Stable DOM attributes exposing the official run state on a bound real node (never from PTY). */
function runNodeDomAttributes(
  node: ProjectedCanvasNode | undefined
): Record<string, string> | undefined {
  if (node === undefined) {
    return undefined;
  }
  return {
    "data-workflow-node-id": node.nodeId,
    "data-runtime-state": node.runtimeState,
    "data-run-attempt": String(node.attempt)
  };
}

/**
 * The card's whole agent surface: who runs this node, whether that agent is usable, or that a choice
 * is still missing. Deliberately three facts and no control — the selector and the full detail
 * (capabilities, recommendations, fallbacks, reason) live in the inspector, so the card stays clean.
 */
function NodeAgentBadge({ data }: { readonly data: CanvasNodeData }) {
  const { t } = useI18n();
  const badge = data.agentBadge;
  if (badge === undefined) return null;
  if (badge.needsSelection) {
    return (
      <small className="node-agent is-unassigned" data-agent-state="needs-selection" role="status">
        {t("agents.needsSelection")}
      </small>
    );
  }
  return (
    <small
      className={`node-agent${badge.available ? "" : " is-unavailable"}`}
      data-agent-adapter={badge.assignedAdapter ?? ""}
      data-agent-state={badge.available ? "available" : "unavailable"}
    >
      {badge.displayName}
      {badge.available ? "" : ` — ${t("agents.unavailable")}`}
    </small>
  );
}

function NodeStatusDetails({ data }: { readonly data: CanvasNodeData }) {
  return (
    <>
      {data.progressPercent === undefined ? null : (
        <div className="node-progress" aria-label={`Progress: ${data.progressPercent}%`}>
          <span>
            <i style={{ width: `${data.progressPercent}%` }} />
          </span>
          <small>{data.progressPercent}% complete</small>
        </div>
      )}
      {data.blocker === undefined ? null : (
        <small className="node-blocker" role="status">
          Blocked: {data.blocker}
        </small>
      )}
    </>
  );
}

function NodePermissionSummary({ data }: { readonly data: CanvasNodeData }) {
  return data.permissions.length === 0 ? null : (
    <small className="node-permissions">Declared capabilities: {data.permissions.join(", ")}</small>
  );
}

function isContextPolicyNode(type: NonNullable<ForgeFlowNode["type"]>): boolean {
  return [
    "note",
    "artifact",
    "text",
    "link",
    "file",
    "folder",
    "image",
    "drawing",
    "page"
  ].includes(type);
}

function TerminalViewport({
  clearEpoch,
  nodeId,
  sessionId
}: {
  readonly clearEpoch: number;
  readonly nodeId: string;
  readonly sessionId: string;
}) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const { reportNodeError } = useTerminalNodeContext();
  const [focused, setFocused] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (element === null) {
      return;
    }
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorInactiveStyle: "outline",
      cursorStyle: "bar",
      fontFamily: "Cascadia Mono, Consolas, monospace",
      fontSize: 13,
      fontWeight: "400",
      fontWeightBold: "600",
      lineHeight: 1.2,
      letterSpacing: 0,
      minimumContrastRatio: 4.5,
      rightClickSelectsWord: true,
      scrollback: 10_000,
      theme: terminalTheme(theme)
    });
    const fitAddon = new FitAddon();
    let active = true;
    let historyReady = false;
    const pendingOutput: Extract<TerminalEvent, { type: "session.output" }>[] = [];
    terminal.loadAddon(fitAddon);
    terminal.open(element);
    terminal.focus();

    const focusTerminal = (event: PointerEvent) => {
      event.stopPropagation();
      terminal.focus();
    };
    const isolatePointer = (event: PointerEvent) => event.stopPropagation();
    const isolateWheel = (event: WheelEvent) => event.stopPropagation();
    element.addEventListener("pointerdown", focusTerminal);
    element.addEventListener("pointermove", isolatePointer);
    element.addEventListener("pointerup", isolatePointer);
    element.addEventListener("pointercancel", isolatePointer);
    element.addEventListener("wheel", isolateWheel);
    const focus = () => setFocused(true);
    const blur = () => setFocused(false);
    element.addEventListener("focusin", focus);
    element.addEventListener("focusout", blur);
    const selection = terminal.onSelectionChange(() => setHasSelection(terminal.hasSelection()));

    const resize = () => {
      if (!element.isConnected || element.clientWidth <= 0 || element.clientHeight <= 0) return;
      try {
        fitAddon.fit();
      } catch {
        // Minimize/restore can expose a zero-sized xterm cell for one frame. Retry on the next
        // ResizeObserver notification instead of sending a bogus PTY dimension.
        return;
      }
      if (terminal.cols < 1 || terminal.rows < 1) return;
      void window.forgedeck.terminals
        .resize({ sessionId, cols: terminal.cols, rows: terminal.rows })
        .catch((error: unknown) =>
          reportNodeError(
            nodeId,
            error instanceof Error ? error.message : t("terminal.resizeFailed")
          )
        );
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    const unsubscribe = window.forgedeck.terminals.onEvent((event) => {
      if (event.type === "session.state") {
        return;
      }
      if (event.sessionId !== sessionId) {
        return;
      }
      if (event.type === "session.output") {
        if (!historyReady) {
          pendingOutput.push(event);
          return;
        }
        terminal.write(event.data);
      }
      if (event.type === "session.error") {
        reportNodeError(nodeId, event.message);
      }
    });
    const finishHistory = (sequence: number) => {
      if (!active) {
        return;
      }
      const liveOutput = pendingOutput.splice(0).filter((event) => event.sequence > sequence);
      historyReady = true;
      for (const event of liveOutput) {
        terminal.write(event.data);
      }
    };
    void window.forgedeck.terminals
      .buffer({ sessionId })
      .then(({ data, sequence }) => {
        if (!active) {
          return;
        }
        if (data.length > 0) {
          terminal.write(data, () => finishHistory(sequence));
          return;
        }
        finishHistory(sequence);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        historyReady = true;
        for (const event of pendingOutput.splice(0)) {
          terminal.write(event.data);
        }
        reportNodeError(
          nodeId,
          error instanceof Error ? error.message : t("terminal.historyFailed")
        );
      });
    const input = terminal.onData((data) => {
      void window.forgedeck.terminals
        .write({ sessionId, data })
        .catch((error: unknown) =>
          reportNodeError(
            nodeId,
            error instanceof Error ? error.message : t("terminal.inputFailed")
          )
        );
    });

    return () => {
      active = false;
      input.dispose();
      selection.dispose();
      element.removeEventListener("focusout", blur);
      element.removeEventListener("focusin", focus);
      unsubscribe();
      observer.disconnect();
      element.removeEventListener("pointerdown", focusTerminal);
      element.removeEventListener("pointermove", isolatePointer);
      element.removeEventListener("pointerup", isolatePointer);
      element.removeEventListener("pointercancel", isolatePointer);
      element.removeEventListener("wheel", isolateWheel);
      terminal.dispose();
    };
  }, [clearEpoch, nodeId, reportNodeError, sessionId, t, theme]);

  return (
    <div
      aria-label={t("terminal.interactionHelp")}
      className={`terminal-viewport nodrag nopan${focused ? " is-focused" : ""}${
        hasSelection ? " has-selection" : ""
      }`}
      ref={host}
      title={t("terminal.interactionHelp")}
    />
  );
}

function terminalTheme(theme: "dark" | "light") {
  if (theme === "light") {
    return {
      background: "#f7f8fa",
      foreground: "#17212b",
      cursor: "#0d6b50",
      cursorAccent: "#f7f8fa",
      black: "#17212b",
      red: "#b42318",
      green: "#087443",
      yellow: "#8a5b00",
      blue: "#175cd3",
      magenta: "#7a3ea1",
      cyan: "#087b8c",
      white: "#f7f8fa",
      brightBlack: "#536171",
      brightRed: "#d92d20",
      brightGreen: "#079455",
      brightYellow: "#b54708",
      brightBlue: "#2e90fa",
      brightMagenta: "#9e77ed",
      brightCyan: "#06aed4",
      brightWhite: "#ffffff",
      selectionBackground: "#b8d6ef",
      selectionForeground: "#0b1722",
      selectionInactiveBackground: "#d6e1ec"
    };
  }
  return {
    background: "#0a0a0a",
    foreground: "#d8dee9",
    cursor: "#72d7b2",
    cursorAccent: "#07100d",
    black: "#171b21",
    red: "#ff6b7a",
    green: "#72d7b2",
    yellow: "#e6c86e",
    blue: "#70a5eb",
    magenta: "#c68aee",
    cyan: "#62d6e8",
    white: "#d8dee9",
    brightBlack: "#6b7480",
    brightRed: "#ff8b97",
    brightGreen: "#91e6c5",
    brightYellow: "#f2dc8c",
    brightBlue: "#8db9f2",
    brightMagenta: "#d8a8f4",
    brightCyan: "#86e2ef",
    brightWhite: "#ffffff",
    selectionBackground: "#315b78",
    selectionForeground: "#ffffff",
    selectionInactiveBackground: "#263746"
  };
}

export const TerminalNode = memo(CanvasNodeView);
export const AgentNode = memo(CanvasNodeView);
export const NoteNode = memo(CanvasNodeView);
export const ArtifactNode = memo(CanvasNodeView);
export const TaskNode = memo(CanvasNodeView);
export const GateNode = memo(CanvasNodeView);
export const ContextSourceNode = memo(CanvasNodeView);
export const ShapeNode = memo(CanvasNodeView);
export const FrameNode = memo(CanvasNodeView);
export const CommentNode = memo(CanvasNodeView);

const nodeTypeIcons: Record<NonNullable<ForgeFlowNode["type"]>, IconName> = {
  terminal: "terminal",
  agent: "agent",
  note: "note",
  artifact: "artifact",
  text: "note",
  link: "search",
  file: "artifact",
  folder: "folder",
  image: "canvas",
  drawing: "canvas",
  page: "note",
  shape: "canvas",
  frame: "organize",
  comment: "note",
  task: "runs",
  gate: "branch"
};

const typeTranslationKeys = {
  terminal: "node.terminal",
  agent: "node.agent",
  note: "node.note",
  artifact: "node.artifact",
  text: "node.note",
  link: "node.note",
  file: "node.artifact",
  folder: "node.note",
  image: "node.artifact",
  drawing: "node.note",
  page: "node.note",
  shape: "node.shape",
  frame: "node.frame",
  comment: "node.comment",
  task: "node.task",
  gate: "node.gate"
} as const;

const runStateTranslationKeys = {
  idle: "runState.idle",
  queued: "runState.queued",
  blocked: "runState.blocked",
  running: "runState.running",
  retrying: "runState.retrying",
  succeeded: "runState.succeeded",
  failed: "runState.failed",
  cancelled: "runState.cancelled"
} as const;

const stateTranslationKeys = {
  idle: "state.idle",
  starting: "state.starting",
  running: "state.running",
  waiting: "state.waiting",
  stopping: "state.stopping",
  blocked: "state.blocked",
  succeeded: "state.succeeded",
  failed: "state.failed",
  cancelled: "state.cancelled",
  interrupted: "state.interrupted",
  disconnected: "state.disconnected",
  ready: "state.ready",
  unavailable: "state.unavailable"
} as const;
