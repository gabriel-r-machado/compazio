import { existsSync, watch } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { trustedRendererIpc } from "./trusted-renderer-ipc";

import {
  AdapterRegistry,
  ExecFileCommandRunner,
  PathExecutableDetector
} from "@forgedeck/agent-adapters";
import { readFeatureFlags } from "@forgedeck/config";

import {
  ConfirmedMergeService,
  MergeConflictDetector,
  PrReadyReportService,
  ProjectRepositoryService,
  QualityGateService,
  WorktreeDiffService,
  WorktreeManager
} from "@forgedeck/git";

import {
  registerCompassoRuntime,
  runLocalMigrations,
  createWorkflowExecutionCheckpointReference,
  createWorkflowRunExecutionContext,
  SqliteArtifactRegistry,
  SqliteAgentMessageStore,
  SqliteAgentLifecycleStore,
  SqliteAgentSpawnStore,
  SqliteWorkspaceArtifactStore,
  SqliteWorkspaceConnectionStore,
  SqliteWorkspaceHandoffStore,
  OrchestrationProposalExecutionService,
  SqliteOrchestrationProposalStore,
  SqliteWorkspaceActivityStore,
  SqliteWorkspaceIncidentStore,
  SqliteWorkspaceNoteStore,
  SqliteCloudSyncStore,
  SqliteAppSettingsRepository,
  SqliteCanvasHandoffRepository,
  SqliteGitStore,
  SqliteLocalIdentityStore,
  SqlitePolicyEngine,
  SqliteCanvasRepository,
  SqliteExecutionContextStore,
  SqliteRuntimeProjectLeaseStore,
  SqliteRuntimeLifecycleStore,
  SqliteRuntimeSessionStore,
  SqliteWorkspaceRepository,
  SqliteWorkflowNodePromptStore,
  SqliteWorkflowRunStore,
  SqliteWorkflowRunCommandStore,
  SqliteWorkflowRunTargetStore,
  SqliteWorkflowDraftStore,
  SqliteWorkflowActivationStore,
  SqliteAutomaticRunStore,
  SqliteWorkspaceContextStore
} from "@forgedeck/local-db";
import { ShellWorkflowNodeExecutor, buildWorkerPrompt } from "@forgedeck/orchestration";
import type {
  WorkerDispatch,
  WorkflowRunExecutionContext,
  WorkflowExecutionCheckpointReference
} from "@forgedeck/orchestration";
import { createLogger, redactText } from "@forgedeck/logger";
import {
  createAllowedEnvironment,
  MemoryLimitMonitor,
  PipeProcessFactory,
  PlatformProcessMemoryReader,
  PlatformProcessTreeKiller,
  ProcessQualityGateRunner,
  ProcessSupervisor,
  PtyProcessFactory,
  TransportProcessFactory
} from "@forgedeck/terminal";
import {
  AGENT_LIFECYCLE_EVENT_CHANNEL,
  AGENT_SPAWN_EVENT_CHANNEL,
  spawnAgentAdapterIdSchema,
  ORCHESTRATOR_COMPOSITION_UPDATED_EVENT_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  WORKFLOW_DRAFT_UPDATED_EVENT_CHANNEL,
  WORKFLOW_RUN_EVENT_CHANNEL,
  WORKSPACE_ACTIVITY_EVENT_CHANNEL,
  WORKSPACE_ARTIFACT_EVENT_CHANNEL,
  WORKSPACE_CONNECTION_EVENT_CHANNEL,
  WORKSPACE_NOTE_EVENT_CHANNEL,
  deriveAgentRuntimeCapabilities,
  toAgentAdapterId,
  AUTOMATIC_EVENT_CHANNEL,
  type AgentAdapterId,
  type TerminalCreateRequest,
  type WorkflowDraft
} from "@forgedeck/schemas";

import { registerCanvasIpc } from "./canvas-ipc";
import { registerAgentMessageIpc } from "./agent-message-ipc";
import { CompassoRuntime, RuntimeProjectConflictError } from "./compasso-runtime";
import { registerCloudSyncIpc } from "./cloud-ipc";
import { CloudSyncService, createFetchCloudSyncTransport } from "./cloud-sync";
import type { CloudSyncTransport } from "./cloud-sync";
import {
  createRendererContentSecurityPolicy,
  withRendererContentSecurityPolicy
} from "./content-security-policy";
import { ElectronCloudCredentialStore } from "./electron-cloud-credentials";
import { ElectronQaDriver } from "./e2e/electron-qa-driver";
import { registerGitIpc } from "./git-ipc";
import { registerHandoffIpc } from "./handoff-ipc";
import { HandoffService } from "./handoff-service";
import { registerOrchestrationProposalIpc } from "./orchestration-proposal-ipc";
import { LocalAuthEndpoint } from "./local-auth-endpoint";
import { ActivationCoordinator } from "./activation-coordinator";
import { OrchestratorDraftDriver } from "./orchestrator-draft-driver";
import { registerOrchestratorSessionIpc } from "./orchestrator-session-ipc";
import { OrchestratorSessionService } from "./orchestrator-session-service";
import { reconcileWorkflowDraftWithCanvasTeam } from "./workflow-team-reconciler";
import { inspectRuntimeAdapters, registerRuntimeIpc } from "./runtime-ipc";
import { registerWorkflowDraftIpc } from "./workflow-draft-ipc";
import { registerAutomaticIpc } from "./automatic-ipc";
import type { AutomaticModeService } from "./automatic-mode-service";
import { createAutomaticModeService } from "./automatic-mode-composition";
import { readRuntimeLimits } from "./runtime-limits";
import { registerSystemIpc } from "./system-ipc";
import { registerSettingsIpc } from "./settings-ipc";
import { createTerminalSession, registerTerminalIpc, sanitizeTerminalEvent } from "./terminal-ipc";
import { provisionCompazioCli, type ProvisionedCompazioCli } from "./cli-provisioning";
import {
  releaseTerminalContext,
  stageTerminalContext,
  sweepTerminalContexts
} from "./terminal-context-staging";
import { TerminalSessionAccessRegistry } from "./terminal-session-access";
import { registerWorkflowIpc } from "./workflow-ipc";
import { WorkflowRunCommandDispatcher } from "./workflow-run-command-dispatcher";
import { WorkflowAgentNodeExecutor } from "./workflow-agent-node-executor";
import { WorkflowHandoffNodeExecutor } from "./workflow-handoff-node-executor";
import { AgentAdapterRegistry } from "./agent-adapter-registry";
import { AgentDescriptorRegistry } from "./agent-descriptor-registry";
import { AgentNodeExecutorRouter } from "./agent-node-executor-router";
import { ClaudeCodeAgentAdapter } from "./claude-code-agent-adapter";
import { CodexAgentAdapter } from "./codex-agent-adapter";
import { OpenCodeAgentAdapter } from "./opencode-agent-adapter";
import { ProcessAgentNodeExecutor } from "./process-agent-node-executor";
import { SafeWorkflowNodeExecutor, WorkflowRunRuntime } from "./workflow-run-runtime";
import {
  InMemoryWorkflowRunRootRegistry,
  ProcessSupervisorShellExecutionAdapter
} from "./workflow-shell-execution-adapter";
import { registerWorkspaceIncidentIpc } from "./workspace-incident-ipc";
import { registerWorkspaceIpc } from "./workspace-ipc";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const compazioWindowIcon = join(currentDirectory, "../../build/icon.png");
const logger = createLogger({ level: process.env.LOG_LEVEL === "debug" ? "debug" : "info" });
const isSmokeTest = process.env.FORGEDECK_SMOKE_TEST === "true";
const smokeProjectRoot = isSmokeTest ? process.env.FORGEDECK_SMOKE_PROJECT_ROOT : undefined;
let canvasRepository: SqliteCanvasRepository | null = null;
let canvasHandoffRepository: SqliteCanvasHandoffRepository | null = null;
let workflowRunStore: SqliteWorkflowRunStore | null = null;
let workflowNodePromptStore: SqliteWorkflowNodePromptStore | null = null;
let workflowRunCommandStore: SqliteWorkflowRunCommandStore | null = null;
let workflowRunTargetStore: SqliteWorkflowRunTargetStore | null = null;
let orchestrationProposalStore: SqliteOrchestrationProposalStore | null = null;
let workflowDraftStore: SqliteWorkflowDraftStore | null = null;
let workflowActivationStore: SqliteWorkflowActivationStore | null = null;
let automaticRunStore: SqliteAutomaticRunStore | null = null;
let automaticModeService: AutomaticModeService | null = null;
let releaseAutomaticIpc: (() => void) | null = null;
let executionContextStore: SqliteExecutionContextStore | null = null;
let releaseWorkflowRunEventSubscription: (() => void) | null = null;
let workflowArtifactRegistry: SqliteArtifactRegistry | null = null;
let gitStore: SqliteGitStore | null = null;
let cloudSyncStore: SqliteCloudSyncStore | null = null;
let runtimeSessionStore: SqliteRuntimeSessionStore | null = null;
let processSupervisor: ProcessSupervisor | null = null;
let liveOrchestratorSessionService: OrchestratorSessionService | null = null;
let workspaceRepository: SqliteWorkspaceRepository | null = null;
let appSettingsRepository: SqliteAppSettingsRepository | null = null;
let agentMessageStore: SqliteAgentMessageStore | null = null;
let agentSpawnStore: SqliteAgentSpawnStore | null = null;
let agentLifecycleStore: SqliteAgentLifecycleStore | null = null;
let terminalMemoryMonitor: MemoryLimitMonitor | null = null;
let workspaceArtifactStore: SqliteWorkspaceArtifactStore | null = null;
let workspaceContextStore: SqliteWorkspaceContextStore | null = null;
let workspaceNoteStore: SqliteWorkspaceNoteStore | null = null;
let workspaceConnectionStore: SqliteWorkspaceConnectionStore | null = null;
let workspaceHandoffStore: SqliteWorkspaceHandoffStore | null = null;
let workspaceActivityStore: SqliteWorkspaceActivityStore | null = null;
let workspaceIncidentStore: SqliteWorkspaceIncidentStore | null = null;
let compassoRuntime: CompassoRuntime | null = null;
let runtimeProjectLeaseStore: SqliteRuntimeProjectLeaseStore | null = null;
let runtimeLifecycleStore: SqliteRuntimeLifecycleStore | null = null;
let localIdentityStore: SqliteLocalIdentityStore | null = null;
let policyEngine: SqlitePolicyEngine | null = null;
let localAuthEndpoint: LocalAuthEndpoint | null = null;
let workflowRunRuntime: WorkflowRunRuntime | null = null;
let hostShutdownStarted = false;

if (isSmokeTest) {
  // Text-only CI smoke runs stay deterministic without a GPU. Real terminal visual acceptance
  // must exercise the same WebGL renderer used by the installed application.
  if (process.env.COMPAZIO_V2_REAL_TUI !== "true") app.disableHardwareAcceleration();
  const smokeUserData = process.env.FORGEDECK_SMOKE_USER_DATA;
  if (
    smokeUserData === undefined ||
    !isAbsolute(smokeUserData) ||
    (smokeProjectRoot !== undefined && !isAbsolute(smokeProjectRoot))
  ) {
    throw new Error("Smoke paths must be absolute");
  }
  app.setPath("userData", smokeUserData);
}

app.setName("Compazio Community Legacy");
app.setAppUserModelId("com.compazio.community.legacy");
if (!isSmokeTest)
  app.setPath("userData", join(app.getPath("appData"), "Compazio Community Legacy"));

const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

let trustedMainWindow: BrowserWindow | null = null;
const privilegedIpc = trustedRendererIpc(ipcMain, () => trustedMainWindow?.webContents ?? null);

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "Compazio",
    ...(existsSync(compazioWindowIcon) ? { icon: compazioWindowIcon } : {}),
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    autoHideMenuBar: true,
    // Visual terminal acceptance uses real native mouse/keyboard events and must exercise a
    // composited, focusable window. Other smoke phases remain hidden.
    show: !isSmokeTest || process.env.COMPAZIO_V2_REAL_TUI === "true",
    backgroundColor: "#0c0f14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(currentDirectory, "../preload/index.cjs")
    }
  });

  trustedMainWindow = window;
  window.once("closed", () => {
    if (trustedMainWindow === window) trustedMainWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  if (isSmokeTest) {
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
      logger.error("Desktop smoke preload failed", {
        preloadPath: basename(preloadPath),
        error: toSmokeError(error)
      });
    });
  }

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl === undefined) {
    void window.loadFile(join(currentDirectory, "../renderer/index.html"));
  } else {
    void window.loadURL(rendererUrl);
  }

  if (isSmokeTest) {
    window.webContents.once("did-finish-load", () => {
      void verifySmokeTest(window).catch((error: unknown) => {
        logger.error("Desktop smoke test failed unexpectedly", error);
        app.exit(1);
      });
    });
  }

  return window;
}

/**
 * The viewports the canvas must stay usable at. Visual QA is done on the REAL production window, so a
 * control that overlaps, a label that clips or a panel that becomes unreachable is caught in the same
 * app the user opens — never in a mock of it.
 */
const SMOKE_VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1024x768", width: 1024, height: 768 }
] as const;

/**
 * Captures the real canvas at each viewport, for human/agent inspection. It runs only when a capture
 * directory is named, writes nothing into the repository or the bundle, and is never part of the
 * ordinary smoke path. The window is shown inactive first: a hidden window can capture blank frames.
 */
async function captureSmokeScreens(window: BrowserWindow): Promise<void> {
  const directory = process.env.FORGEDECK_SMOKE_CAPTURE_DIR;
  if (directory === undefined) return;
  if (!isAbsolute(directory)) throw new Error("Smoke paths must be absolute");
  await mkdir(directory, { recursive: true });
  // Capturing must leave the window exactly as it found it: the checks that run after this one are
  // written against the default size and visibility, and a resized or hidden window fails them.
  const originalSize = window.getContentSize();
  const width = originalSize[0] ?? 1180;
  const height = originalSize[1] ?? 760;
  const wasVisible = window.isVisible();
  window.showInactive();
  try {
    for (const viewport of SMOKE_VIEWPORTS) {
      window.setContentSize(viewport.width, viewport.height);
      // Two frames make the resized React Flow layout observable without relying on a fixed delay.
      await waitForRendererPaint(window);
      const image = await window.webContents.capturePage();
      await writeFile(join(directory, `canvas-${viewport.name}.png`), image.toPNG());
      logger.info("Desktop smoke screenshot captured", { viewport: viewport.name });
    }
  } finally {
    window.setContentSize(width, height);
    await waitForRendererPaint(window);
    if (!wasVisible) window.hide();
  }
}

async function verifySmokeTest(window: BrowserWindow): Promise<void> {
  const qa = new ElectronQaDriver(window);
  if (!(await waitForRendererStatus(window))) {
    logger.error("Desktop smoke test failed", { reason: "typed IPC ping did not complete" });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke ping completed");

  const rendererStylesApplied: unknown = await window.webContents.executeJavaScript(
    `document.body !== null &&
      window.getComputedStyle(document.body).backgroundColor === "rgb(5, 5, 5)" &&
      document.styleSheets.length > 0`,
    true
  );
  if (rendererStylesApplied !== true) {
    logger.error("Desktop smoke test failed", {
      reason: "renderer design tokens were not applied"
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke renderer styles completed");

  const canvasWorkspaceReady: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      const projects=await window.forgedeck.projects.list();
      return document.querySelector('[aria-label="Canvas do workspace Compazio"]')!==null &&
        document.querySelector('#open-project-title')?.textContent?.includes('Abra um projeto')===true &&
        document.querySelector('[aria-label="Workspaces abertos"]')!==null &&
        document.querySelectorAll('.workspace-sidebar-footer nav button').length===3 &&
        document.querySelector('.workspace-section-nav')===null &&
        document.querySelector('.workspace-menu')===null &&
        typeof window.forgedeck.workspaces.list === "function" &&
        typeof window.forgedeck.agentSpawns.onEvent === "function" &&
        typeof window.forgedeck.notes.onEvent === "function" &&
        typeof window.forgedeck.connections.onEvent === "function" &&
        typeof window.forgedeck.workspaceActivity.onEvent === "function" &&
        typeof window.forgedeck.orchestrationProposals.create === "function" &&
        typeof window.forgedeck.orchestrationProposals.approve === "function" &&
        typeof window.forgedeck.orchestrationProposals.execute === "function" &&
        typeof window.forgedeck.orchestrationProposals.planningOptions === "function" &&
        typeof window.forgedeck.workflows.onEvent === "function" &&
        typeof window.forgedeck.workflows.graph === "function" &&
        typeof window.forgedeck.settings.get === "function" &&
        typeof window.forgedeck.projects.listBranches === "function" &&
        typeof window.forgedeck.projects.switchBranch === "function" &&
         (()=>{
           const workspaceBar=document.querySelector('.workspace-bar');
           const canvasTools=document.querySelector('.canvas-tools');
           if(workspaceBar===null || canvasTools===null) return true;
           return Number(window.getComputedStyle(workspaceBar).zIndex) >
             Number(window.getComputedStyle(canvasTools).zIndex);
         })() &&
        document.querySelector('.rail:not([hidden])')===null &&
        document.querySelector('[data-testid="creation-mode-automatic"]')===null &&
        Array.isArray(projects);
    })()`,
    true
  );
  if (canvasWorkspaceReady !== true) {
    logger.error("Desktop smoke test failed", {
      reason: "canvas-first workspace or typed project-list IPC did not open"
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke canvas-first workspace completed");

  await captureSmokeScreens(window);

  const terminalFacadeReady: unknown = await window.webContents.executeJavaScript(
    `typeof window.forgedeck.terminals.create === "function" &&
      typeof window.forgedeck.terminals.clear === "function" &&
      typeof window.forgedeck.terminals.onEvent === "function" &&
      !("invoke" in window.forgedeck) && !("ipcRenderer" in window)`,
    true
  );
  if (terminalFacadeReady !== true) {
    logger.error("Desktop smoke test failed", {
      reason: "typed terminal facade was missing or a generic IPC bridge was exposed"
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke terminal facade completed");

  const workflowRunsPanelReady: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      const buttons=document.querySelectorAll('.workspace-sidebar-footer nav button');
      const runsButton=buttons.item(1);
      const canvasButton=buttons.item(0);
      if(!(runsButton instanceof HTMLButtonElement) || !(canvasButton instanceof HTMLButtonElement)) {
        return { ready:false, buttonCount:buttons.length, buttonTexts:[...buttons].map((button)=>button.textContent) };
      }
      runsButton.click();
      await new Promise((resolve)=>setTimeout(resolve,80));
      const ready=(document.querySelector('#workflow-runs-title')!==null ||
        document.body?.innerText?.includes('Workflows auditáveis')===true) &&
        document.querySelector('.workflow-run-history')!==null;
      const afterRuns={
        ready,
        title:document.querySelector('#workflow-runs-title')?.textContent ?? null,
        history:document.querySelector('.workflow-run-history')!==null,
        activeButton:runsButton.getAttribute('aria-current'),
        bodyText:document.body?.innerText?.slice(0,240) ?? null
      };
      canvasButton.click();
      await new Promise((resolve)=>setTimeout(resolve,80));
      const canvasRestored=document.querySelector('.react-flow__pane')!==null ||
        document.querySelector('.canvas-empty-state')!==null;
      return {
        ...afterRuns,
        ready:ready && canvasRestored,
        canvas:canvasRestored
      };
    })()`,
    true
  );
  const workflowRunsReady =
    typeof workflowRunsPanelReady === "object" &&
    workflowRunsPanelReady !== null &&
    "ready" in workflowRunsPanelReady &&
    workflowRunsPanelReady.ready === true;
  if (!workflowRunsReady) {
    logger.error("Desktop smoke test failed", {
      reason: "workflow run panel or typed live event facade was unavailable",
      diagnostics: workflowRunsPanelReady
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke workflow run panel completed");

  // Open the temporary Git project before workspace-scoped persistence checks. This keeps the
  // assertions on the same canvas id the renderer uses after a workspace switch/reload.
  window.showInactive();
  window.focus();
  const smokeProjectOpened =
    (await qa.click('[data-testid="project-open"]')) &&
    (await qa.waitForExpression(
      `(()=>{const button=document.querySelector('[data-testid="canvas-add-node"]');return button instanceof HTMLButtonElement && !button.disabled;})()`
    ));
  if (!smokeProjectOpened) {
    logger.error("Desktop smoke test failed", {
      reason: "the temporary local Git project could not be opened through the project picker"
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke local project picker completed");

  const initialNodeCount: unknown = await window.webContents.executeJavaScript(
    "document.querySelectorAll('.react-flow__node').length",
    true
  );
  if (initialNodeCount !== 0) {
    logger.error("Desktop smoke test failed", {
      reason: "a new workspace did not start with an empty canvas",
      nodeCount: initialNodeCount
    });
    app.exit(1);
    return;
  }

  const terminalDraftReady: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      const pane=document.querySelector('.react-flow__pane');
      if(pane===null) return document.querySelector('.canvas-empty-state')!==null;
      pane.dispatchEvent(new MouseEvent('mousedown',{
        bubbles:true,button:2,buttons:2,clientX:260,clientY:220
      }));
      window.dispatchEvent(new MouseEvent('mousemove',{
        bubbles:true,button:2,buttons:2,clientX:860,clientY:620
      }));
      await new Promise(resolve=>setTimeout(resolve,30));
      const preview=document.querySelector('.terminal-draft-preview');
      const ready=preview!==null && preview.getBoundingClientRect().width>=590 &&
        preview.getBoundingClientRect().height>=390;
      window.dispatchEvent(new MouseEvent('mouseup',{
        bubbles:true,button:2,buttons:0,clientX:860,clientY:620
      }));
      return ready;
    })()`,
    true
  );
  if (terminalDraftReady !== true) {
    logger.error("Desktop smoke test failed", {
      reason: "right-drag terminal preview did not preserve the drafted rectangle"
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke right-drag terminal draft completed");

  // The draft interaction is intentionally exercised against the real project canvas, but the
  // smoke must not leave a shell running while it proceeds with persistence checks. Cancel only
  // sessions created by this temporary fixture through the typed terminal facade.
  await window.webContents.executeJavaScript(
    `(async()=>{
      await new Promise(resolve=>setTimeout(resolve,120));
      const sessions=await window.forgedeck.terminals.list();
      for(const session of sessions){
        if(!['stopped','completed','failed'].includes(session.state)){
          await window.forgedeck.terminals.cancel({sessionId:session.id}).catch(()=>undefined);
        }
      }
      return true;
    })()`,
    true
  );

  if (!(await waitForCanvasSaved(window))) {
    logger.error("Desktop smoke test failed", { reason: "initial canvas autosave did not finish" });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke seed autosave completed");

  const savedRevision: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      const workspaces=await window.forgedeck.workspaces.list();
      const canvasId=workspaces.find((workspace)=>workspace.isOpen)?.canvasId ?? "default";
      const loaded=await window.forgedeck.canvases.load({canvasId});
      const revision=loaded.snapshot?.revision ?? 0;
      const result=await window.forgedeck.canvases.save({snapshot:{
        id:canvasId,title:"Forty node smoke",revision,viewport:{x:24,y:48,zoom:0.55},
        nodes:Array.from({length:40},(_,index)=>({
          id:"smoke-node-"+index,type:index===0?"terminal":index===1?"note":"task",
          position:{x:(index%8)*240,y:Math.floor(index/8)*160},
          ...(index===0?{width:560,height:380}:{}),
          data:{title:index===0?"Smoke terminal":index===1?"Smoke note":"Task "+index,
            state:"idle",summary:"Smoke projection",
            ...(index===0?{adapterId:"shell"}:{}),...(index===1?{content:"Resizable note"}:{}),
            retryMaxAttempts:1,permissions:[]}
        })),edges:[{id:"smoke-edge-0",source:"smoke-node-0",target:"smoke-node-1",contract:{
          schemaVersion:"1.0",kind:"dependency",label:"depends on",requiredEvidenceTypes:[]
        }}]
      }});
      return { revision: result.revision, canvasId };
    })()`,
    true
  );
  if (
    typeof savedRevision !== "object" ||
    savedRevision === null ||
    !("revision" in savedRevision) ||
    typeof savedRevision.revision !== "number" ||
    savedRevision.revision < 1
  ) {
    logger.error("Desktop smoke test failed", {
      reason: "canvas did not persist through typed IPC"
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke 40-node canvas persisted", { savedRevision });

  const loaded = new Promise<void>((resolve) =>
    window.webContents.once("did-finish-load", resolve)
  );
  window.webContents.reload();
  await loaded;
  logger.info("Desktop smoke renderer reloaded");
  if (!(await waitForRendererStatus(window))) {
    logger.error("Desktop smoke test failed", { reason: "renderer did not recover after reload" });
    app.exit(1);
    return;
  }

  const restoredState: unknown = await window.webContents.executeJavaScript(
    `Promise.all([
      window.forgedeck.workspaces.list().then((workspaces)=>{
        const canvasId=workspaces.find((workspace)=>workspace.isOpen)?.canvasId ?? "default";
        return window.forgedeck.canvases.load({canvasId});
      }),
      window.forgedeck.workflows.listTemplates()
    ]).then(([canvas,templates])=>({nodeCount:canvas.snapshot?.nodes.length ?? -1,templateCount:templates.length}))`,
    true
  );
  if (
    !isSmokeRestoredState(restoredState) ||
    restoredState.nodeCount !== 40 ||
    restoredState.templateCount !== 2
  ) {
    logger.error("Desktop smoke test failed", {
      reason: "restored 40-node canvas or workflow templates were not available"
    });
    app.exit(1);
    return;
  }

  const collapsedCanvasReady: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      const toggle=document.querySelector('.workspace-sidebar-toggle');
      if(!(toggle instanceof HTMLElement)) return false;
      for(let attempt=0;attempt<40 && document.querySelectorAll('.react-flow__node').length!==40;attempt+=1){
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      toggle.click();
      await new Promise(resolve=>setTimeout(resolve,240));
      const flow=document.querySelector('.flow-surface');
      const ready=document.querySelector('.workspace-sidebar')===null &&
        document.querySelector('.workspace-sidebar-reopen')!==null &&
        document.querySelectorAll('.react-flow__node').length===40 &&
        (flow?.getBoundingClientRect().width ?? 0)>800;
      const diagnostics={
        ready,
        sidebar:document.querySelector('.workspace-sidebar')!==null,
        reopen:document.querySelector('.workspace-sidebar-reopen')!==null,
        nodeCount:document.querySelectorAll('.react-flow__node').length,
        flowWidth:flow?.getBoundingClientRect().width ?? null
      };
      const reopen=document.querySelector('.workspace-sidebar-reopen');
      if(reopen instanceof HTMLElement) reopen.click();
      await new Promise(resolve=>setTimeout(resolve,240));
      return {
        ...diagnostics,
        restored:document.querySelector('.workspace-sidebar')!==null,
        ready:ready && document.querySelector('.workspace-sidebar')!==null
      };
    })()`,
    true
  );
  const collapsedCanvasIsReady =
    typeof collapsedCanvasReady === "object" &&
    collapsedCanvasReady !== null &&
    "ready" in collapsedCanvasReady &&
    collapsedCanvasReady.ready === true;
  if (!collapsedCanvasIsReady) {
    logger.error("Desktop smoke test failed", {
      reason: "collapsing project navigation hid or displaced the canvas",
      diagnostics: collapsedCanvasReady
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke collapsed navigation completed");

  // The current canvas keeps orchestration on the terminal/agent surface rather than exposing a
  // separate automatic-mode page. Validate the typed session API and the canvas creation surface.
  const orchestratorApiReady: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      const api=window.forgedeck;
      const apiOk = typeof api?.orchestratorSession?.start==='function'
        && typeof api?.orchestratorSession?.sendObjective==='function'
        && typeof api?.workflowDraft?.onUpdated==='function';
      const canvasToolbar=document.querySelector('[data-testid="canvas-toolbar"]');
      const addTerminal=document.querySelector('[data-testid="canvas-add-terminal"]');
      return {
        apiOk,
        canvasToolbar:canvasToolbar!==null,
        addTerminal:addTerminal instanceof HTMLButtonElement,
        bodyText:document.body?.innerText?.slice(0,240) ?? null
      };
    })()`,
    true
  );
  const orchestratorReady =
    typeof orchestratorApiReady === "object" &&
    orchestratorApiReady !== null &&
    "apiOk" in orchestratorApiReady &&
    orchestratorApiReady.apiOk === true &&
    "canvasToolbar" in orchestratorApiReady &&
    orchestratorApiReady.canvasToolbar === true &&
    "addTerminal" in orchestratorApiReady &&
    orchestratorApiReady.addTerminal === true;
  if (!orchestratorReady) {
    logger.error("Desktop smoke test failed", {
      reason: "orchestrator session API was not exposed through the preload",
      diagnostics: orchestratorApiReady
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke orchestrator session API completed");

  /*
  const contextualActionsReady: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      for(let attempt=0;attempt<40;attempt+=1){
        const node=document.querySelector('.react-flow__node[data-id="smoke-node-0"]');
        if(node!==null){
          const rail=node.querySelector('.node-connect-rail-source');
          const railCoversSide=rail!==null &&
            rail.getBoundingClientRect().height >= node.getBoundingClientRect().height*0.7;
          const railHasNoPoint=rail!==null && getComputedStyle(rail,'::after').display==='none';
          node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:240,clientY:180}));
          await new Promise(resolve=>setTimeout(resolve,30));
          const menu=document.querySelector('[aria-label="Ações do nó"]');
          return railCoversSide && railHasNoPoint &&
            document.querySelectorAll('.canvas-tools').length===1 &&
            document.querySelector('.selection-toolbar')!==null &&
            node.querySelector('.terminal-statusbar')!==null &&
            menu?.textContent?.includes('Limpar terminal')===true &&
            menu.textContent.includes('Reiniciar sessão') && menu.textContent.includes('Excluir');
        }
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      return false;
    })()`,
    true
  );
  if (contextualActionsReady !== true) {
    logger.error("Desktop smoke test failed", {
      reason: "terminal context actions did not open from a right click"
    });
    app.exit(1);
    return;
  }
  */
  // Chromium input, not a renderer event dispatch: this verifies the real Windows right-click path.
  // Chromium ignores pointer injection for a hidden, unfocused native window on Windows. Layout can
  // also change when that window is first shown, so calculate the target only after its next paint.
  window.show();
  window.focus();
  window.webContents.focus();
  await waitForRendererPaint(window);
  const terminalNodeTarget = await elementInputPoint(
    window,
    '.react-flow__node[data-id="smoke-node-0"]'
  );
  if (terminalNodeTarget === null) {
    logger.error("Desktop smoke test failed", {
      reason: "terminal context target was not available after the renderer was focused"
    });
    app.exit(1);
    return;
  }
  rightClick(window, terminalNodeTarget);
  const contextMenuOpened = await waitForDomCondition(
    window,
    `(()=>{
      const menu=document.querySelector('[data-testid="canvas-context-menu"]');
      const node=document.querySelector('.react-flow__node[data-id="smoke-node-0"]');
      const rail=node?.querySelector('.node-connect-rail-source');
      return menu?.getAttribute('role')==='menu' &&
        menu.textContent?.includes('Limpar terminal')===true &&
        menu.textContent.includes('Reiniciar sess') && menu.textContent.includes('Excluir') &&
        rail!==null && rail.getBoundingClientRect().height >= node.getBoundingClientRect().height*0.7 &&
        getComputedStyle(rail,'::after').display==='none' &&
        document.querySelectorAll('.canvas-tools').length===1 &&
        node.querySelector('.terminal-statusbar')!==null;
    })()`
  );
  if (!contextMenuOpened) {
    const diagnostics: unknown = await window.webContents.executeJavaScript(
      `(()=>{
        const menu=document.querySelector('[data-testid="canvas-context-menu"]');
        const node=document.querySelector('.react-flow__node[data-id="smoke-node-0"]');
        const rail=node?.querySelector('.node-connect-rail-source');
        const target=document.elementFromPoint(${terminalNodeTarget.x},${terminalNodeTarget.y});
        return {
          menu:menu!==null,
          menuText:menu?.textContent ?? null,
          node:node!==null,
          selectedToolbar:document.querySelector('.selection-toolbar')!==null,
          terminalStatus:node?.querySelector('.terminal-statusbar')!==null,
          railHeight:rail?.getBoundingClientRect().height ?? null,
          nodeHeight:node?.getBoundingClientRect().height ?? null,
          target:target?.className ?? null
        };
      })()`,
      true
    );
    logger.error("Desktop smoke test failed", {
      reason: "terminal context actions did not open from a real right click",
      diagnostics
    });
    app.exit(1);
    return;
  }

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESCAPE" });
  if (
    !(await waitForDomCondition(
      window,
      "document.querySelector('[data-testid=\"canvas-context-menu\"]') === null"
    ))
  ) {
    logger.error("Desktop smoke test failed", {
      reason: "Escape did not close the terminal context menu"
    });
    app.exit(1);
    return;
  }

  rightClick(window, terminalNodeTarget);
  if (
    !(await waitForDomCondition(
      window,
      'document.querySelector(\'[data-testid="canvas-context-menu"] [role="menuitem"]\') !== null'
    ))
  ) {
    logger.error("Desktop smoke test failed", {
      reason: "terminal context menu could not be reopened"
    });
    app.exit(1);
    return;
  }
  const centerActionTarget = await elementInputPoint(
    window,
    '[data-testid="canvas-context-menu"] [aria-label="Abrir em foco"]'
  );
  if (centerActionTarget === null) {
    logger.error("Desktop smoke test failed", {
      reason: "terminal context menu action was not addressable"
    });
    app.exit(1);
    return;
  }
  leftClick(window, centerActionTarget);
  if (
    !(await waitForDomCondition(
      window,
      `document.querySelector('[data-testid="canvas-context-menu"]') === null &&
        document.querySelector('.react-flow__node[data-id="smoke-node-0"]') !== null`
    ))
  ) {
    logger.error("Desktop smoke test failed", {
      reason: "terminal context menu action did not complete through real pointer input"
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke terminal context menu completed");

  const safeCanvasAreas = await verifyCanvasSafeAreas(window);
  if (!safeCanvasAreas.ok) {
    logger.error("Desktop smoke test failed", {
      reason: "canvas lower controls, counter or minimap escaped their shared safe area",
      detail: safeCanvasAreas.detail
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke canvas safe areas completed");
  // If requested, overwrite the initial-state captures with the populated real canvas after every
  // responsive assertion has passed. The directory is external to the bundle and workspace source.
  await captureSmokeScreens(window);

  const spatialEditingReady: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      const note=document.querySelector('.react-flow__node[data-id="smoke-node-1"]');
      const edge=document.querySelector('.react-flow__edge[data-id="smoke-edge-0"]');
      const interaction=edge?.querySelector('.react-flow__edge-interaction');
      const pane=document.querySelector('.react-flow__pane');
      const viewport=document.querySelector('.react-flow__viewport');
      if(note===null || edge===null || interaction===null || pane===null || viewport===null) return false;
      note.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:520,clientY:220}));
      await new Promise(resolve=>setTimeout(resolve,30));
      const noteContent=note.querySelector('.flow-node-resizable');
      const noteEditor=note.querySelector('.note-content-editor');
      const noteBounds=note.getBoundingClientRect();
      const noteContentBounds=noteContent?.getBoundingClientRect();
      const visibleResizeHandles=[...note.querySelectorAll('.node-resize-handle')]
        .filter(handle=>getComputedStyle(handle).display!=='none' &&
          handle.getBoundingClientRect().width>=10 && handle.getBoundingClientRect().height>=10);
      const noteCanResize=visibleResizeHandles.length===4 && noteBounds.width>=160 &&
        noteBounds.height>=110 && noteContentBounds!==undefined &&
        Math.abs(noteBounds.width-noteContentBounds.width)<=2 &&
        Math.abs(noteBounds.height-noteContentBounds.height)<=2;
      const noteIsEditable=noteEditor instanceof HTMLTextAreaElement &&
        !noteEditor.readOnly && !noteEditor.disabled;
      const viewportBefore=viewport.getAttribute('style');
      pane.dispatchEvent(new MouseEvent('mousedown',{
        bubbles:true,button:0,buttons:1,clientX:820,clientY:620,view:window
      }));
      window.dispatchEvent(new MouseEvent('mousemove',{
        bubbles:true,button:0,buttons:1,clientX:760,clientY:570,view:window
      }));
      window.dispatchEvent(new MouseEvent('mouseup',{
        bubbles:true,button:0,buttons:0,clientX:760,clientY:570,view:window
      }));
      await new Promise(resolve=>setTimeout(resolve,30));
      const leftDragPans=viewport.getAttribute('style')!==viewportBefore;
      const wideHitTarget=getComputedStyle(interaction).strokeWidth==='36px';
      const cut=document.querySelector('[aria-label="Cortar conexões"]');
      const undo=document.querySelector('[aria-label="Desfazer"]');
      if(!(cut instanceof HTMLElement) || !(undo instanceof HTMLElement)) return false;
      cut.click();
      await new Promise(resolve=>setTimeout(resolve,30));
      interaction.dispatchEvent(new MouseEvent('click',{
        bubbles:true,button:0,buttons:0,clientX:450,clientY:230
      }));
      await new Promise(resolve=>setTimeout(resolve,30));
      const removed=document.querySelector('.react-flow__edge[data-id="smoke-edge-0"]')===null;
      const remainedClickable=!cut.hasAttribute('disabled');
      cut.click();
      await new Promise(resolve=>setTimeout(resolve,30));
      const deactivated=cut.getAttribute('aria-pressed')==='false';
      undo.click();
      await new Promise(resolve=>setTimeout(resolve,30));
      const restored=document.querySelector('.react-flow__edge[data-id="smoke-edge-0"]')!==null;
      if(noteCanResize && noteIsEditable && leftDragPans && wideHitTarget && removed && remainedClickable &&
        deactivated && restored) return true;
      return JSON.stringify({noteCanResize,noteIsEditable,leftDragPans,wideHitTarget,removed,remainedClickable,
        deactivated,restored,handleCount:visibleResizeHandles.length,
        noteWidth:noteBounds.width,noteHeight:noteBounds.height,
        contentWidth:noteContentBounds?.width ?? null,contentHeight:noteContentBounds?.height ?? null});
    })()`,
    true
  );
  if (spatialEditingReady !== true) {
    logger.error("Desktop smoke test failed", {
      reason:
        "note editing, resizing, left-drag panning, scissors toggle or recoverable connection history was unavailable",
      detail: spatialEditingReady
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke note resize, scissors and undo completed");

  const templatesVisible: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      const more=document.querySelector('.canvas-tool-more summary');
      if(!(more instanceof HTMLElement)) return { more:false };
      more.click();
      await new Promise(resolve=>setTimeout(resolve,30));
      const button=[...document.querySelectorAll('.canvas-tool-more [role="menuitem"]')]
        .find((entry)=>entry.textContent?.includes('Modelos prontos'));
      if(!(button instanceof HTMLButtonElement)) return { more:true, button:false };
      button.click();
      await new Promise(resolve=>setTimeout(resolve,30));
      const menu=document.querySelector('.canvas-template-menu');
      const visible=menu?.textContent?.includes('Blueprint para PR')===true;
      const close=menu?.querySelector('[aria-label="Fechar modelos"]');
      if(close instanceof HTMLButtonElement) close.click();
      await new Promise(resolve=>setTimeout(resolve,30));
      const closed=document.querySelector('.canvas-template-menu')===null;
      return visible && closed || {
        buttonDisabled:button.disabled,
        expanded:button.getAttribute('aria-expanded'),
        menuPresent:menu!==null,
        visible,
        closed
      };
    })()`,
    true
  );
  if (templatesVisible !== true) {
    logger.error("Desktop smoke test failed", {
      reason: "canvas templates were not discoverable from the canvas",
      detail: templatesVisible
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke canvas templates completed");

  await seedSmokeHandoffWorkspace();
  const handoffLoaded = new Promise<void>((resolve) =>
    window.webContents.once("did-finish-load", resolve)
  );
  window.webContents.reload();
  await handoffLoaded;
  if (!(await waitForRendererStatus(window))) {
    logger.error("Desktop smoke test failed", {
      reason: "renderer did not load the reviewed handoff workspace"
    });
    app.exit(1);
    return;
  }
  const runsMonitoringReady: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      const buttons=document.querySelectorAll('.workspace-sidebar-footer nav button');
      const runsButton=buttons.item(1);
      const canvasButton=buttons.item(0);
      if(!(runsButton instanceof HTMLButtonElement) || !(canvasButton instanceof HTMLButtonElement)) return false;
      runsButton.click();
      let monitoring=null;
      for(let attempt=0;attempt<20;attempt+=1){
        monitoring=document.querySelector('.orchestration-proposals');
        if(monitoring!==null) break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      // The runs screen is now follow-up only: no proposal creation editor lives here.
      const editorRemoved=document.querySelector('.orchestration-proposal-editor')===null;
      const monitoringVisible=monitoring?.textContent?.includes('Propostas para revisão')===true &&
        monitoring?.textContent?.includes('modo Automático no canvas')===true;
      canvasButton.click();
      await new Promise(resolve=>setTimeout(resolve,50));
      return editorRemoved && monitoringVisible &&
        document.querySelector('.react-flow__pane')!==null;
    })()`,
    true
  );
  if (runsMonitoringReady !== true) {
    logger.error("Desktop smoke test failed", {
      reason: "runs screen did not become a monitoring-only surface without the proposal editor"
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke runs monitoring surface completed");
  logger.info("Desktop smoke canvas orchestration controls are terminal-scoped");

  // With a local project already activated through the normal picker, this scenario uses the same
  // canvas controls a person uses. It does not call renderer handlers, IPC methods or stores
  // directly: the QA driver only sends Chromium pointer/keyboard input and observes the visible result.
  window.showInactive();
  window.focus();
  const manualHybridNodeBaseline: unknown = await window.webContents.executeJavaScript(
    "document.querySelectorAll('.react-flow__node').length",
    true
  );
  if (typeof manualHybridNodeBaseline !== "number") {
    logger.error("Desktop smoke test failed", {
      reason: "the canvas node baseline was not observable before the Manual workflow"
    });
    app.exit(1);
    return;
  }
  const manualHybridExpectedNodeCount = manualHybridNodeBaseline + 1;
  const manualHybridSteps: string[] = [];
  const completeManualHybridStep = async (name: string, action: () => Promise<boolean>) => {
    const completed = await action();
    if (!completed) manualHybridSteps.push(name);
    return completed;
  };
  let manualHybridWorkflowReady = await completeManualHybridStep("active project", () =>
    qa.waitForExpression(
      `(()=>{const button=document.querySelector('[data-testid="canvas-add-node"]');return button instanceof HTMLButtonElement && !button.disabled;})()`
    )
  );
  if (manualHybridWorkflowReady) {
    manualHybridWorkflowReady = await completeManualHybridStep("open node palette", () =>
      qa.click('[data-testid="canvas-add-node"]')
    );
  }
  if (manualHybridWorkflowReady) {
    manualHybridWorkflowReady = await completeManualHybridStep("note palette entry", () =>
      qa.waitForSelector('[data-testid="palette-add-note"]')
    );
  }
  if (manualHybridWorkflowReady) {
    manualHybridWorkflowReady = await completeManualHybridStep("create manual note", () =>
      qa.click('[data-testid="palette-add-note"]')
    );
  }
  if (manualHybridWorkflowReady) {
    manualHybridWorkflowReady = await completeManualHybridStep("manual note visible", () =>
      qa.waitForExpression(
        `document.querySelectorAll('.react-flow__node').length === ${manualHybridExpectedNodeCount}`
      )
    );
  }
  if (manualHybridWorkflowReady) {
    manualHybridWorkflowReady = await completeManualHybridStep("manual node preserved", () =>
      qa.waitForExpression(
        `document.querySelector('.compose-bar') === null && document.querySelectorAll('.react-flow__node').length === ${manualHybridExpectedNodeCount}`
      )
    );
  }
  if (!manualHybridWorkflowReady) {
    const diagnostics: unknown = await window.webContents.executeJavaScript(
      `(()=>({
        projectOpen:document.querySelector('[data-testid="project-open"]')!==null,
        addNode:document.querySelector('[data-testid="canvas-add-node"]')!==null,
        noteEntry:document.querySelector('[data-testid="palette-add-note"]')!==null,
        nodeCount:document.querySelectorAll('.react-flow__node').length,
        title:document.title
      }))()`,
      true
    );
    logger.error("Desktop smoke test failed", {
      reason:
        "a local project could not complete the canvas note workflow through real window input",
      manualHybridSteps,
      diagnostics
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke local Manual canvas workflow completed");

  const themePreferenceReady: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      const buttons=document.querySelectorAll('.workspace-sidebar-footer nav button');
      const canvasButton=buttons.item(0);
      const settingsButton=buttons.item(2);
      if(!(canvasButton instanceof HTMLButtonElement) || !(settingsButton instanceof HTMLButtonElement)) return false;
      settingsButton.click();
      // The appearance toggle only mounts after the settings panel resolves two
      // IPC calls (runtime diagnostics + cloud status). Allow ~3s so a slow load
      // right after the reload and 40-node canvas does not flake this step.
      for(let attempt=0;attempt<60;attempt+=1){
        const toggle=document.querySelector('.theme-toggle');
        if(toggle instanceof HTMLButtonElement){
          toggle.click();
          await new Promise(resolve=>setTimeout(resolve,40));
          const switched=document.documentElement.dataset.theme==='light';
          toggle.click();
          await new Promise(resolve=>setTimeout(resolve,40));
          canvasButton.click();
          return switched && document.documentElement.dataset.theme==='dark';
        }
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      return false;
    })()`,
    true
  );
  if (themePreferenceReady !== true) {
    logger.error("Desktop smoke test failed", {
      reason: "persisted light and dark appearance control was unavailable"
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke appearance preference completed");
  const reviewedHandoffReady: unknown = await window.webContents.executeJavaScript(
    `(async()=>{
      const workspaces=await window.forgedeck.workspaces.list();
      const workspace=workspaces.find(item=>item.title==='Handoff smoke');
      if(workspace===undefined) return false;
      const draft=await window.forgedeck.handoffs.createDraft({
        canvasId:workspace.canvasId,sourceNodeId:'handoff-source',
        targetNodeId:'handoff-target',edgeId:'handoff-edge'
      });
      const ready=await window.forgedeck.handoffs.markReady({
        handoffId:draft.id,revision:draft.revision,content:{
          summary:'Entrega revisada no smoke test',
          completedWork:['Implementação concluída'],
          decisions:['Manter revisão humana'],
          evidence:[{label:'Teste',detail:'Smoke do Electron'}],
          openQuestions:[],risks:[]
        }
      });
      const events=await window.forgedeck.handoffs.listEvents({handoffId:ready.id});
      const more=document.querySelector('.canvas-tool-more summary');
      if(more instanceof HTMLElement) more.click();
      let historyButton=null;
      for(let attempt=0;attempt<60;attempt+=1){
        historyButton=[...document.querySelectorAll('button')]
          .find(button=>['Entregas','Deliveries'].includes(button.textContent?.trim() ?? '')) ?? null;
        if(historyButton instanceof HTMLElement) break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(!(historyButton instanceof HTMLElement)) return false;
      historyButton.click();
      let refresh=null;
      for(let attempt=0;attempt<60;attempt+=1){
        refresh=document.querySelector('[aria-label="Atualizar entregas"],[aria-label="Refresh deliveries"]');
        if(refresh instanceof HTMLElement) break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(!(refresh instanceof HTMLElement)) return false;
      refresh.click();
      for(let attempt=0;attempt<100;attempt+=1){
        const item=document.querySelector('.handoff-history li > button');
        if(item instanceof HTMLElement){
          item.click();
          await new Promise(resolve=>setTimeout(resolve,50));
          const dialog=document.querySelector('[aria-label="Revisar entrega"],[aria-label="Review delivery"]');
          return ready.status==='ready' &&
            events.some(event=>event.type==='handoff_ready') &&
            dialog?.textContent?.includes('Entrega revisada no smoke test')===true &&
            (dialog.textContent.includes('Pronto para enviar') || dialog.textContent.includes('Ready to send')) &&
            dialog.querySelector('textarea')?.hasAttribute('disabled')===true;
        }
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      return false;
    })()`,
    true
  );
  if (reviewedHandoffReady !== true) {
    logger.error("Desktop smoke test failed", {
      reason: "reviewed handoff history was not available through typed IPC and the UI"
    });
    app.exit(1);
    return;
  }
  logger.info("Desktop smoke reviewed handoff completed");

  logger.info("Desktop smoke test passed", {
    restoredNodeCount: restoredState.nodeCount,
    templateCount: restoredState.templateCount,
    typedIpc: true
  });
  app.exit(0);
}

async function seedSmokeHandoffWorkspace(): Promise<void> {
  if (
    gitStore === null ||
    workspaceRepository === null ||
    canvasRepository === null ||
    appSettingsRepository === null
  ) {
    throw new Error("Smoke repositories are not available");
  }
  const timestamp = new Date().toISOString();
  await gitStore.saveProject({
    id: "00000000-0000-4000-8000-000000000101",
    name: "Handoff smoke",
    // The interactive smoke has already added smokeProjectRoot through the normal picker. Keep
    // this legacy handoff fixture on the application repository so its seeded project cannot collide
    // with that real project record.
    rootPath: app.getAppPath(),
    canonicalRootPath: app.getAppPath(),
    defaultBranch: "main",
    headCommit: "0123456789abcdef0123456789abcdef01234567",
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const workspace = workspaceRepository.create({
    projectId: "00000000-0000-4000-8000-000000000101",
    title: "Handoff smoke"
  });
  const snapshot = canvasRepository.load(workspace.canvasId);
  if (snapshot === null) throw new Error("Smoke handoff canvas was not created");
  canvasRepository.save({
    ...snapshot,
    mission: "Revisar uma entrega sem avanço automático",
    nodes: [
      {
        id: "handoff-source",
        type: "agent",
        position: { x: 80, y: 100 },
        data: smokeHandoffNode("Implementação")
      },
      {
        id: "handoff-target",
        type: "agent",
        position: { x: 620, y: 100 },
        data: smokeHandoffNode("Revisão")
      }
    ],
    edges: [
      {
        id: "handoff-edge",
        source: "handoff-source",
        target: "handoff-target",
        contract: {
          schemaVersion: "1.0",
          kind: "handoff",
          label: "Revisar",
          requiredEvidenceTypes: ["test"],
          handoffMode: "manual",
          sourceDeliverable: "Implementação com evidências",
          targetInstruction: "Validar os critérios de aceite"
        }
      }
    ]
  });
  appSettingsRepository.setActiveWorkspaceId(workspace.id);
}

function smokeHandoffNode(name: string) {
  return {
    title: name,
    state: "idle" as const,
    summary: "",
    adapterId: "codex",
    retryMaxAttempts: 1,
    permissions: [],
    role: {
      name,
      responsibilities: "Cumprir a etapa atribuída",
      constraints: "Não ampliar permissões",
      expectedDeliverable: "Pacote estruturado",
      completionCriteria: "Evidências revisáveis"
    }
  };
}

async function waitForRendererStatus(window: BrowserWindow): Promise<boolean> {
  let lastStatus: unknown = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let status: unknown;
    try {
      status = await executeRendererScript(
        window,
        "document.documentElement.dataset.ipcStatus ?? ''",
        1_000
      );
    } catch (error: unknown) {
      lastStatus = { error: toSmokeError(error) };
      break;
    }
    lastStatus = status;
    if (status === "ok") {
      return true;
    }
    if (status === "failed") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const diagnostics = await diagnoseRendererIpc(window);
  logger.error("Desktop smoke typed IPC diagnostics", {
    status: lastStatus,
    diagnostics
  });
  return false;
}

/**
 * Exercises every request used by the renderer bootstrap with an explicit timeout. The old smoke
 * only waited for a shared DOM flag, which made a rejected or hung request indistinguishable from a
 * preload that never loaded. Results contain only operation names and sanitized error text.
 */
async function diagnoseRendererIpc(window: BrowserWindow): Promise<unknown> {
  try {
    return await executeRendererScript(
      window,
      `(async()=>{
        const timeoutMs=1000;
        const run=async(name, action)=>{
          try{
            await Promise.race([
              Promise.resolve().then(action),
              new Promise((_, reject)=>setTimeout(()=>reject(new Error("IPC_TIMEOUT")), timeoutMs))
            ]);
            return { ok: true };
          }catch(error){
            return {
              ok: false,
              error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
            };
          }
        };
        const checks={
          "system.ping": await run("system.ping", ()=>window.forgedeck.system.ping({requestId:crypto.randomUUID()})),
          "canvases.load": await run("canvases.load", ()=>window.forgedeck.canvases.load({canvasId:"default"})),
          "projects.list": await run("projects.list", ()=>window.forgedeck.projects.list()),
          "workspaces.list": await run("workspaces.list", ()=>window.forgedeck.workspaces.list()),
          "settings.get": await run("settings.get", ()=>window.forgedeck.settings.get())
        };
        return { status: document.documentElement.dataset.ipcStatus ?? "", checks };
      })()`,
      6_000
    );
  } catch (error: unknown) {
    return {
      ok: false,
      error: toSmokeError(error)
    };
  }
}

function executeRendererScript(
  window: BrowserWindow,
  script: string,
  timeoutMs: number
): Promise<unknown> {
  return Promise.race([
    window.webContents.executeJavaScript(script, true),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("RENDERER_EXECUTE_TIMEOUT")), timeoutMs);
    })
  ]);
}

function toSmokeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}

async function waitForCanvasSaved(window: BrowserWindow): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const saved: unknown = await window.webContents.executeJavaScript(
      "document.querySelector('.save-indicator')?.getAttribute('title') === 'Salvo localmente'",
      true
    );
    if (saved === true) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

interface SmokeInputPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Resolve a visible element to a device-independent point, then let Chromium deliver actual input
 * to it. The driver intentionally observes DOM state only after interaction; it never calls a
 * renderer handler or writes renderer state.
 */
async function elementInputPoint(
  window: BrowserWindow,
  selector: string
): Promise<SmokeInputPoint | null> {
  const point: unknown = await window.webContents.executeJavaScript(
    `(()=>{
      const element=document.querySelector(${JSON.stringify(selector)});
      if(!(element instanceof HTMLElement)) return null;
      const bounds=element.getBoundingClientRect();
      if(bounds.width<2 || bounds.height<2) return null;
      return {
        x:Math.round(bounds.left+Math.min(bounds.width/2, 96)),
        y:Math.round(bounds.top+Math.min(bounds.height/2, 48))
      };
    })()`,
    true
  );
  if (typeof point !== "object" || point === null || !("x" in point) || !("y" in point)) {
    return null;
  }
  const x = point.x;
  const y = point.y;
  if (typeof x !== "number" || typeof y !== "number") return null;
  return { x, y };
}

function rightClick(window: BrowserWindow, point: SmokeInputPoint): void {
  window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  window.webContents.sendInputEvent({
    type: "mouseDown",
    x: point.x,
    y: point.y,
    button: "right",
    clickCount: 1
  });
  window.webContents.sendInputEvent({
    type: "mouseUp",
    x: point.x,
    y: point.y,
    button: "right",
    clickCount: 1
  });
}

function leftClick(window: BrowserWindow, point: SmokeInputPoint): void {
  window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  window.webContents.sendInputEvent({
    type: "mouseDown",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1
  });
  window.webContents.sendInputEvent({
    type: "mouseUp",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1
  });
}

/** Wait for an observable renderer condition instead of delaying for an arbitrary duration. */
async function waitForDomCondition(window: BrowserWindow, expression: string): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const matched: unknown = await window.webContents.executeJavaScript(expression, true);
    if (matched === true) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
  return false;
}

async function waitForRendererPaint(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    "Promise.race([new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise((resolve)=>setTimeout(resolve,250))])",
    true
  );
}

async function verifyCanvasSafeAreas(
  window: BrowserWindow
): Promise<{ readonly ok: boolean; readonly detail: unknown }> {
  const originalSize = window.getContentSize();
  const details: unknown[] = [];
  try {
    for (const viewport of SMOKE_VIEWPORTS) {
      window.setContentSize(viewport.width, viewport.height);
      await waitForRendererPaint(window);
      const measurement: unknown = await window.webContents.executeJavaScript(
        `(()=>{
          const rect=(element)=>{
            const box=element?.getBoundingClientRect();
            return box===undefined?null:{left:box.left,top:box.top,right:box.right,bottom:box.bottom,width:box.width,height:box.height};
          };
          const contains=(outer,inner)=>outer!==null && inner!==null &&
            inner.left>=outer.left && inner.top>=outer.top && inner.right<=outer.right && inner.bottom<=outer.bottom;
          const collides=(left,right)=>left!==null && right!==null &&
            left.left<right.right && left.right>right.left && left.top<right.bottom && left.bottom>right.top;
          const surface=document.querySelector('[data-testid="canvas-surface"]');
          const toolbar=document.querySelector('[data-testid="canvas-toolbar"]');
          const count=document.querySelector('.canvas-count');
          const minimap=document.querySelector('.react-flow__minimap');
          // "Cortar" moved into the toolbar's overflow menu: rare actions no longer compete with the
          // work for space. It must still be present and enabled — reachable, not visible at rest.
          const cut=toolbar?.querySelector('[aria-label^="Cortar"]');
          // The create actions moved out of the header and into the single toolbar.
          const createActions=[...(toolbar?.querySelectorAll(
            '[data-testid="canvas-add-terminal"],[data-testid="canvas-add-node"]'
          )??[])];
          const styles=toolbar===null?null:getComputedStyle(toolbar);
          const body=document.body;
          const root=document.documentElement;
          const toolbarBox=rect(toolbar);
          const result={
            viewport:${JSON.stringify(viewport.name)},
            surface:rect(surface),toolbar:toolbarBox,count:rect(count),minimap:rect(minimap),
            toolbarContained:contains(rect(surface),toolbarBox),
            toolbarCanScroll:toolbar instanceof HTMLElement &&
              (toolbar.scrollWidth<=toolbar.clientWidth || styles?.overflowX==='auto' || styles?.overflowX==='scroll'),
            cutReachable:cut instanceof HTMLButtonElement && cut.getAttribute('aria-label')!==null &&
              cut.isConnected,
            countClear:!collides(rect(count),toolbarBox) && !collides(rect(count),rect(minimap)),
            minimapClear:minimap!==null && !collides(rect(minimap),toolbarBox),
            headerActionsFit:createActions.length===2 && createActions.every((button)=>{
              const box=rect(button);
              return box!==null && box.left>=0 && box.right<=window.innerWidth;
            }),
            pageFits:body.scrollWidth<=window.innerWidth && root.scrollWidth<=window.innerWidth
          };
          return result;
        })()`,
        true
      );
      details.push(measurement);
    }
  } finally {
    window.setContentSize(originalSize[0] ?? 1180, originalSize[1] ?? 760);
    await waitForRendererPaint(window);
  }
  const ok = details.every(
    (detail) =>
      typeof detail === "object" &&
      detail !== null &&
      "toolbarContained" in detail &&
      detail.toolbarContained === true &&
      "toolbarCanScroll" in detail &&
      detail.toolbarCanScroll === true &&
      "cutReachable" in detail &&
      detail.cutReachable === true &&
      "countClear" in detail &&
      detail.countClear === true &&
      "minimapClear" in detail &&
      detail.minimapClear === true &&
      "headerActionsFit" in detail &&
      detail.headerActionsFit === true &&
      "pageFits" in detail &&
      detail.pageFits === true
  );
  return { ok, detail: details };
}

/** Observes only the known local SQLite files; no renderer path is accepted or exposed. */
function observeWorkspaceDatabase(filename: string, onChange: () => void): () => void {
  const databaseName = basename(filename);
  try {
    const watcher = watch(dirname(filename), { persistent: false }, (_eventType, changedFile) => {
      const changedName = changedFile === null ? null : changedFile.toString();
      if (
        changedName === null ||
        changedName === databaseName ||
        changedName === `${databaseName}-wal` ||
        changedName === `${databaseName}-shm`
      ) {
        onChange();
      }
    });
    return () => watcher.close();
  } catch {
    // The slow dispatcher fallback remains available on filesystems without watch support.
    return () => undefined;
  }
}

registerSystemIpc(privilegedIpc);

if (isPrimaryInstance)
  void app
    .whenReady()
    .then(async () => {
      const databaseFilename = join(app.getPath("userData"), "forgedeck.db");
      const migrationsFolder = app.isPackaged
        ? join(process.resourcesPath, "drizzle")
        : join(app.getAppPath(), "../../packages/local-db/drizzle");
      runLocalMigrations({ filename: databaseFilename, migrationsFolder });
      canvasRepository = new SqliteCanvasRepository(databaseFilename);
      canvasHandoffRepository = new SqliteCanvasHandoffRepository(databaseFilename);
      workflowRunStore = new SqliteWorkflowRunStore(databaseFilename);
      workflowNodePromptStore = new SqliteWorkflowNodePromptStore(databaseFilename);
      workflowRunCommandStore = new SqliteWorkflowRunCommandStore(databaseFilename);
      workflowRunTargetStore = new SqliteWorkflowRunTargetStore(databaseFilename);
      orchestrationProposalStore = new SqliteOrchestrationProposalStore(databaseFilename);
      workflowDraftStore = new SqliteWorkflowDraftStore(databaseFilename);
      workflowActivationStore = new SqliteWorkflowActivationStore(databaseFilename);
      automaticRunStore = new SqliteAutomaticRunStore(databaseFilename);
      executionContextStore = new SqliteExecutionContextStore(databaseFilename);
      workflowArtifactRegistry = new SqliteArtifactRegistry(
        databaseFilename,
        join(app.getPath("userData"), "compasso-artifacts")
      );
      gitStore = new SqliteGitStore(databaseFilename);
      cloudSyncStore = new SqliteCloudSyncStore(databaseFilename);
      runtimeSessionStore = new SqliteRuntimeSessionStore(databaseFilename);
      workspaceRepository = new SqliteWorkspaceRepository(databaseFilename);
      appSettingsRepository = new SqliteAppSettingsRepository(databaseFilename);
      agentMessageStore = new SqliteAgentMessageStore(databaseFilename);
      agentSpawnStore = new SqliteAgentSpawnStore(databaseFilename);
      agentLifecycleStore = new SqliteAgentLifecycleStore(databaseFilename);
      workspaceArtifactStore = new SqliteWorkspaceArtifactStore(databaseFilename);
      workspaceContextStore = new SqliteWorkspaceContextStore(databaseFilename);
      // Notes are real markdown files under the project, so an agent can read and edit them with
      // the tools it already has instead of only through this product.
      workspaceNoteStore = new SqliteWorkspaceNoteStore(databaseFilename, { notesOnDisk: true });
      workspaceConnectionStore = new SqliteWorkspaceConnectionStore(databaseFilename);
      workspaceHandoffStore = new SqliteWorkspaceHandoffStore(databaseFilename);
      workspaceActivityStore = new SqliteWorkspaceActivityStore(databaseFilename);
      workspaceIncidentStore = new SqliteWorkspaceIncidentStore(databaseFilename);
      localIdentityStore = new SqliteLocalIdentityStore(databaseFilename);
      policyEngine = new SqlitePolicyEngine(databaseFilename);
      runtimeProjectLeaseStore = new SqliteRuntimeProjectLeaseStore(databaseFilename);
      runtimeLifecycleStore = new SqliteRuntimeLifecycleStore(databaseFilename);
      const runtimeLimits = readRuntimeLimits(process.env);
      const staleRuntimeLeasesRecovered = runtimeProjectLeaseStore.recoverStale(
        new Date(Date.now() - runtimeLimits.projectLeaseStaleAfterMs).toISOString()
      );
      localIdentityStore.ensureIdentity({
        kind: "user",
        subjectId: "local-user",
        label: "Local user"
      });
      localIdentityStore.ensureIdentity({
        kind: "runtime",
        subjectId: "desktop-runtime",
        label: "Compazio desktop runtime"
      });
      const cliIdentity = localIdentityStore.ensureIdentity({
        kind: "cli",
        subjectId: "compasso-cli",
        label: "Compazio CLI"
      });
      localIdentityStore.ensureIdentity({
        kind: "orchestrator",
        subjectId: "compasso-orchestrator",
        label: "Compazio orchestration service"
      });
      const cliCredential = localIdentityStore.issueSession(cliIdentity.id);
      localAuthEndpoint = new LocalAuthEndpoint(localIdentityStore);
      const localAuthAddress = await localAuthEndpoint.start();
      processSupervisor = new ProcessSupervisor(
        new TransportProcessFactory({
          pty: new PtyProcessFactory(runtimePlatform()),
          pipe: new PipeProcessFactory()
        }),
        {
          sessionStore: runtimeSessionStore,
          maxQueuedMessages: runtimeLimits.maxQueuedMessagesPerSession,
          maxQueuedBytes: runtimeLimits.maxQueuedBytesPerSession,
          maxBufferLines: runtimeLimits.maxBufferLinesPerSession
        }
      );
      const interruptedSessionsRecovered = await processSupervisor.recoverInterrupted();
      const interruptedRuntimeControlsRecovered = runtimeLifecycleStore.recoverInterrupted();
      const featureFlags = readFeatureFlags(process.env);
      let cloudTransport: CloudSyncTransport | null = null;
      if (featureFlags.cloud && process.env.FORGEDECK_CLOUD_SYNC_API_URL !== undefined) {
        try {
          cloudTransport = createFetchCloudSyncTransport(process.env.FORGEDECK_CLOUD_SYNC_API_URL);
        } catch {
          cloudSyncStore.setLastErrorCode("configuration_invalid");
          logger.warn("Cloud sync endpoint configuration is invalid");
        }
      }
      const cloudSync = new CloudSyncService({
        cloudFeatureEnabled: featureFlags.cloud,
        store: cloudSyncStore,
        credentials: new ElectronCloudCredentialStore(cloudSyncStore),
        transport: cloudTransport
      });
      const interruptedRunsRecovered = workflowRunStore.recoverInterruptedRuns();
      const interruptedWorkflowRunCommandsRecovered = workflowRunCommandStore.recoverInterrupted();
      const interruptedHandoffDeliveriesRecovered = canvasHandoffRepository.recoverDeliveries();
      const interruptedAgentMessagesRecovered = agentMessageStore.recoverInterruptedDeliveries();
      const interruptedAgentSpawnsRecovered = agentSpawnStore.recoverInterrupted();
      const interruptedAgentLifecycleCommandsRecovered = agentLifecycleStore.recoverInterrupted();
      const interruptedWorkspaceNoteProjectionsRecovered =
        workspaceNoteStore.recoverProjectionDeliveries();
      const interruptedWorkspaceConnectionProjectionsRecovered =
        workspaceConnectionStore.recoverProjectionDeliveries();
      const preservedWorktreeLeases: string[] = [];
      for (const gateProcess of await gitStore.listGateProcesses()) {
        if (isProcessAlive(gateProcess.processId)) {
          preservedWorktreeLeases.push(gateProcess.worktreeId);
          logger.warn("Interrupted quality gate PID is still in use; lease preserved", {
            gateRunId: gateProcess.gateRunId
          });
        } else {
          await gitStore.removeGateProcess(gateProcess.gateRunId);
        }
      }
      const interruptedWorktreeLeasesRecovered =
        await gitStore.recoverLeases(preservedWorktreeLeases);
      const interruptedProjectLeasesRecovered = await gitStore.recoverProjectLeases();
      const interruptedGateRunsRecovered = await gitStore.recoverGateRuns(new Date().toISOString());
      const managedWorktreeRoot = join(app.getPath("userData"), "worktrees");
      // The `compazio` command an agent runs from inside its own terminal. Installed on every
      // launch so it always points at the CLI bundled with the running app. A failure here must not
      // stop the app from opening: terminals still work, they just cannot talk back to the runtime.
      let compazioCli: ProvisionedCompazioCli | null = null;
      try {
        compazioCli = provisionCompazioCli({
          binDirectory: join(app.getPath("userData"), "bin"),
          electronExecutable: process.execPath,
          cliEntrypoint: join(app.getAppPath(), "out", "main", "compazio-cli.js"),
          platform: runtimePlatform()
        });
      } catch {
        logger.warn("The compazio command could not be installed for agent terminals");
      }
      const projects = new ProjectRepositoryService(gitStore);
      // A crash or a kill never gives the owning process a chance to release its own staged
      // material, so the host reclaims it here — the same audited recovery shape used for stale
      // leases and interrupted sessions.
      const liveSessionIds = processSupervisor.listSessions().map((session) => session.id);
      let staleTerminalContextsRemoved = 0;
      for (const project of await projects.list()) {
        try {
          staleTerminalContextsRemoved += sweepTerminalContexts({
            projectRoot: project.canonicalRootPath,
            activeSessionIds: liveSessionIds
          });
        } catch {
          logger.warn("Staged terminal context sweep skipped a project");
        }
      }
      if (staleTerminalContextsRemoved > 0) {
        logger.warn("Removed staged terminal context left by a previous session", {
          count: staleTerminalContextsRemoved
        });
      }
      let registerProjectRuntime: (
        projectRoot: string
      ) => Promise<void> = async (): Promise<void> => {
        throw new Error("Compazio Runtime is still initializing");
      };
      const sessionAccess = new TerminalSessionAccessRegistry();
      const adapters = new AdapterRegistry();
      const worktrees = new WorktreeManager(gitStore, gitStore, managedWorktreeRoot);
      const diffs = new WorktreeDiffService(gitStore, gitStore);
      const conflicts = new MergeConflictDetector(gitStore, managedWorktreeRoot);
      const qualityGates = new QualityGateService(
        gitStore,
        gitStore,
        worktrees,
        gitStore,
        gitStore,
        new ProcessQualityGateRunner()
      );
      const reports = new PrReadyReportService(
        gitStore,
        gitStore,
        gitStore,
        gitStore,
        diffs,
        conflicts
      );
      const workflowRoots = new InMemoryWorkflowRunRootRegistry();
      const activeWorkspaceRepository = workspaceRepository;
      const activeWorkflowRunCommandStore = workflowRunCommandStore;
      const activeWorkflowRunTargetStore = workflowRunTargetStore;
      const activeExecutionContextStore = executionContextStore;
      const activeWorkspaceHandoffStore = workspaceHandoffStore;
      const workflowShell = new ProcessSupervisorShellExecutionAdapter(
        processSupervisor,
        workflowRoots
      );
      // The production process adapters: Claude Code, Codex and OpenCode, each run single-shot through the SAME
      // shared ProcessAgentNodeExecutor + ProcessSupervisor. Adapter selection is strictly by
      // node.adapter; an unknown id fails before a process starts, and an agent that is not installed
      // is reported unavailable rather than attempted. No smoke or fake adapter is registered here.
      const agentAdapterRegistry = new AgentAdapterRegistry([
        new ClaudeCodeAgentAdapter({
          detector: new PathExecutableDetector(),
          commandRunner: new ExecFileCommandRunner(),
          platform: runtimePlatform(),
          environment: process.env
        }),
        new CodexAgentAdapter({
          detector: new PathExecutableDetector(),
          commandRunner: new ExecFileCommandRunner(),
          platform: runtimePlatform(),
          environment: process.env
        }),
        new OpenCodeAgentAdapter({
          detector: new PathExecutableDetector(),
          commandRunner: new ExecFileCommandRunner(),
          platform: runtimePlatform(),
          environment: process.env
        })
      ]);
      // The catalog of agents Compazio knows about. It is deliberately separate from the adapter
      // registry above: Codex and OpenCode are described honestly as known-but-unavailable here,
      // while only agents with a registered adapter can ever be launched.
      const agentDescriptors = new AgentDescriptorRegistry(agentAdapterRegistry);
      const activeAutomaticRunStore = automaticRunStore;
      const activeWorkflowRunStore = workflowRunStore;
      const activeWorkflowNodePromptStore = workflowNodePromptStore;
      const processAgentNodeExecutor = new ProcessAgentNodeExecutor(
        processSupervisor,
        workflowArtifactRegistry,
        workflowRoots,
        agentAdapterRegistry,
        process.env,
        // Automatic mode's generated prompts cannot travel in the official definition, so the executor
        // reads each node's prompt for the run it is launching. A node with no recorded prompt is
        // ordinary work and keeps using its title.
        {
          getNodePrompt: (runId, nodeId) =>
            activeWorkflowNodePromptStore.getNodePrompt(runId, nodeId) ??
            activeAutomaticRunStore.getNodePrompt(runId, nodeId)
        },
        {
          onStarting: ({ sessionId, runId, nodeId, attempt, adapterId }) => {
            const adapter = toAgentAdapterId(adapterId);
            const workspaceId = activeWorkflowRunStore.get(runId)?.executionContext?.workspaceId;
            const workspace =
              workspaceId === undefined ? null : activeWorkspaceRepository.get(workspaceId);
            if (adapter === null || workspace === null) return;
            sessionAccess.bind(sessionId, {
              projectId: workspace.projectId,
              adapterId: adapter,
              workspaceId: workspace.id,
              canvasNodeId: nodeId,
              workflow: { runId, nodeId, attempt },
              readOnly: true
            });
          }
        }
      );
      const workflowRuntime = new WorkflowRunRuntime(
        new SafeWorkflowNodeExecutor(
          new ShellWorkflowNodeExecutor(workflowShell),
          // Agent nodes route by node.adapter: registered process adapters run through the process
          // executor; adapter-less nodes keep the existing message-based delivery path.
          new AgentNodeExecutorRouter(
            agentAdapterRegistry,
            processAgentNodeExecutor,
            new WorkflowAgentNodeExecutor(workflowRunTargetStore, agentMessageStore)
          ),
          new WorkflowHandoffNodeExecutor(workflowRunTargetStore, activeWorkspaceHandoffStore)
        ),
        workflowRunStore,
        workflowArtifactRegistry,
        workflowRoots
      );
      // Held at module scope so the shutdown sequence can drain it before any store is closed.
      workflowRunRuntime = workflowRuntime;
      // Automatic mode composes the SAME live runtime, scheduler, supervisor, artifact registry and local
      // database as every other flow. It adds a session store and two ports; it starts no second engine.
      const resolveAutomaticWorkspaceRoot = async (workspaceId: string): Promise<string | null> => {
        const workspace = activeWorkspaceRepository.get(workspaceId);
        if (workspace === null) return null;
        const project = await projects.get(workspace.projectId);
        return project?.canonicalRootPath ?? null;
      };
      const automaticCheckRunnerFor = (workspaceId: string) => ({
        run: async (command: string) => {
          const root = await resolveAutomaticWorkspaceRoot(workspaceId);
          if (root === null) {
            return {
              command,
              exitCode: 1,
              ok: false,
              summary: "The selected project folder is unavailable."
            };
          }
          const [executable, ...args] = command.split(" ").filter((part) => part.length > 0);
          if (executable === undefined) {
            return { command, exitCode: 1, ok: false, summary: "Empty verification command." };
          }
          const result = await new ProcessQualityGateRunner().run({
            sessionId: `automatic-verify-${globalThis.crypto.randomUUID()}`,
            executable: { path: executable, kind: "command-shim" },
            args,
            cwd: root,
            allowedCwdRoot: root,
            timeoutMs: 10 * 60 * 1_000
          });
          return {
            command,
            exitCode: result.exitCode ?? 1,
            ok: result.exitCode === 0 && !result.timedOut,
            summary: result.outputSummary.slice(-2_000)
          };
        }
      });
      automaticModeService = createAutomaticModeService({
        runtime: workflowRuntime,
        supervisor: processSupervisor,
        adapters: agentAdapterRegistry,
        store: activeAutomaticRunStore,
        activations: workflowActivationStore,
        artifacts: workflowArtifactRegistry,
        resolveWorkspaceRoot: resolveAutomaticWorkspaceRoot,
        sanitize: (text) => redactText(text),
        publish: (event) => {
          // Events only invalidate; the renderer re-reads the snapshot, which stays the truth.
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(AUTOMATIC_EVENT_CHANNEL, event);
          }
        },
        // Verification runs the node's allowlisted commands through the same gate runner the rest of the
        // product uses, and a verdict is its exit code — never its text.
        // The runner is bound to the chosen local project for every automatic session. It never
        // executes a verification command from Compazio's own installation directory.
        checkRunner: automaticCheckRunnerFor(""),
        checkRunnerFor: automaticCheckRunnerFor
      });
      releaseAutomaticIpc = registerAutomaticIpc(privilegedIpc, automaticModeService);
      const workflowRunDispatcher = new WorkflowRunCommandDispatcher(
        activeWorkflowRunCommandStore,
        workflowRuntime,
        {
          resolveWorkspace: async (workspaceId) => {
            const workspace = activeWorkspaceRepository.get(workspaceId);
            if (workspace === null) return null;
            const project = await projects.get(workspace.projectId);
            if (project === null) return null;
            return {
              workspaceId: workspace.id,
              projectId: project.id,
              root: project.canonicalRootPath
            };
          },
          getRunTarget: (runId) => activeWorkflowRunTargetStore.get(runId),
          bindRunTarget: (input) => {
            activeWorkflowRunTargetStore.bind(input);
          }
        },
        {
          createFunctionContext: (input) =>
            createWorkflowRunExecutionContext(
              activeExecutionContextStore.checkpoint({ ...input, type: "function" })
            ),
          createDeliveryCheckpoint: async (input) =>
            createWorkflowExecutionCheckpointReference(
              activeExecutionContextStore.checkpoint({ ...input, type: "delivery" })
            )
        },
        { create: (input) => worktrees.create(input) }
      );
      releaseWorkflowRunEventSubscription?.();
      releaseWorkflowRunEventSubscription = workflowRunStore.subscribe((event) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(WORKFLOW_RUN_EVENT_CHANNEL, event);
        }
      });
      const merges = new ConfirmedMergeService(
        gitStore,
        gitStore,
        gitStore,
        gitStore,
        gitStore,
        worktrees,
        qualityGates,
        conflicts
      );
      registerCanvasIpc(privilegedIpc, canvasRepository);
      // Assigned once the terminal services exist (below). Approval may only fire after the UI is up,
      // so this forward reference is always populated by the time a worker is dispatched.
      let activationCoordinator: ActivationCoordinator | null = null;
      let activeApprovedDraft: WorkflowDraft | null = null;
      registerWorkflowDraftIpc(privilegedIpc, workflowDraftStore, {
        inspectAdapters: inspectRuntimeAdapters,
        // Live agent catalog for the per-node selector and the assignment presets.
        agents: async () => ({ descriptors: await agentDescriptors.refresh() }),
        // Increment A: approval materializes the draft into exactly one official run through the
        // single live WorkflowRunRuntime. The result (runId/status/issues) is returned to the renderer.
        onApproved: async (draft) => {
          activeApprovedDraft = draft;
          return (await activationCoordinator?.materialize(draft)) ?? null;
        }
      });
      // Automatic sessions that were mid-flight when the app stopped are picked up where they stood. A
      // session with no run yet, or one still owing a human decision, is deliberately left alone.
      void automaticModeService.resumeInterrupted().then(
        (resumed) => {
          if (resumed.length > 0) {
            logger.info("Resumed interrupted automatic sessions", { count: resumed.length });
          }
        },
        (error: unknown) => {
          logger.error("Failed to resume interrupted automatic sessions", {
            reason: error instanceof Error ? error.message : "unknown"
          });
        }
      );
      registerAgentMessageIpc(privilegedIpc, agentMessageStore);
      registerHandoffIpc(
        privilegedIpc,
        new HandoffService({
          store: canvasHandoffRepository,
          canvases: canvasRepository,
          workspaces: workspaceRepository,
          sessions: sessionAccess,
          terminal: processSupervisor,
          adapters,
          policy: policyEngine
        })
      );
      registerWorkspaceIpc(privilegedIpc, workspaceRepository);
      registerWorkspaceIncidentIpc(privilegedIpc, workspaceIncidentStore);
      registerOrchestrationProposalIpc(
        privilegedIpc,
        orchestrationProposalStore,
        new OrchestrationProposalExecutionService(
          orchestrationProposalStore,
          activeWorkflowRunCommandStore,
          agentMessageStore,
          policyEngine
        ),
        agentMessageStore
      );
      registerSettingsIpc(privilegedIpc, appSettingsRepository);
      registerCloudSyncIpc(privilegedIpc, cloudSync);
      registerWorkflowIpc(privilegedIpc, workflowRuntime, {
        requestStart: (input) => {
          const command = activeWorkflowRunCommandStore.requestStart(input);
          return {
            id: command.id,
            action: "start" as const,
            status: "queued" as const,
            createdAt: command.createdAt
          };
        },
        requestControl: (input) => {
          const command = activeWorkflowRunCommandStore.requestControl(input);
          return {
            id: command.id,
            action: input.action,
            status: "queued" as const,
            createdAt: command.createdAt
          };
        }
      });
      registerGitIpc(privilegedIpc, {
        projects,
        worktrees,
        diffs,
        qualityGates,
        reports,
        merges,
        chooseDirectory: async () => {
          if (smokeProjectRoot !== undefined) return smokeProjectRoot;
          const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        chooseCloneDestination: async () => {
          const result = await dialog.showOpenDialog({
            properties: ["openDirectory", "createDirectory"],
            title: "Choose where to clone the GitHub repository"
          });
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        confirmGitHubClone: async (repositoryUrl) =>
          (
            await dialog.showMessageBox({
              type: "warning",
              buttons: ["Cancel", "Clone repository"],
              defaultId: 0,
              cancelId: 0,
              message: "Clone this GitHub repository locally?",
              detail: `Compazio will clone ${repositoryUrl} into a folder you choose. No shell command, destination path or credentials are accepted from the renderer.`
            })
          ).response === 1,
        confirmBranchSwitch: async (branchName) =>
          (
            await dialog.showMessageBox({
              type: "question",
              buttons: ["Cancel", "Switch branch"],
              defaultId: 1,
              cancelId: 0,
              message: `Switch this project to ${branchName}?`,
              detail:
                "Compazio will only switch a clean working tree. Active terminal processes keep running in the same project folder."
            })
          ).response === 1,
        confirmCleanup: async () =>
          (
            await dialog.showMessageBox({
              type: "warning",
              buttons: ["Cancel", "Remove clean worktree"],
              defaultId: 0,
              cancelId: 0,
              message: "Remove this managed worktree?",
              detail:
                "Compazio will revalidate locks and refuse any uncommitted, untracked or ignored files. The branch is preserved."
            })
          ).response === 1,
        registerProjectRuntime: (projectRoot) => registerProjectRuntime(projectRoot),
        confirmMerge: async () =>
          (
            await dialog.showMessageBox({
              type: "warning",
              buttons: ["Cancel", "Merge"],
              defaultId: 0,
              cancelId: 0,
              message: "Confirm the prepared Git merge?",
              detail:
                "Compazio will revalidate the source, target, conflicts and quality-gate evidence before merging."
            })
          ).response === 1
      });
      registerRuntimeIpc(privilegedIpc, {
        interruptedSessionsRecovered,
        interruptedRunsRecovered,
        interruptedWorktreeLeasesRecovered,
        interruptedProjectLeasesRecovered,
        interruptedGateRunsRecovered
      });
      if (interruptedWorkflowRunCommandsRecovered > 0) {
        logger.warn("Interrupted workflow controls require manual resubmission", {
          count: interruptedWorkflowRunCommandsRecovered
        });
      }
      if (interruptedHandoffDeliveriesRecovered > 0) {
        logger.warn("Interrupted handoff deliveries require manual review", {
          count: interruptedHandoffDeliveriesRecovered
        });
      }
      if (interruptedAgentMessagesRecovered > 0) {
        logger.warn("Interrupted agent messages require manual review", {
          count: interruptedAgentMessagesRecovered
        });
      }
      if (interruptedRuntimeControlsRecovered > 0) {
        logger.warn("Interrupted runtime controls require an explicit new command", {
          count: interruptedRuntimeControlsRecovered
        });
      }
      if (staleRuntimeLeasesRecovered > 0) {
        logger.warn("Stale Compazio Runtime leases were recovered after missed heartbeats", {
          count: staleRuntimeLeasesRecovered
        });
      }
      if (interruptedAgentSpawnsRecovered > 0) {
        logger.warn("Interrupted agent spawns require manual review", {
          count: interruptedAgentSpawnsRecovered
        });
      }
      if (interruptedAgentLifecycleCommandsRecovered > 0) {
        // Never replayed: re-running one could close a terminal the user reopened since.
        logger.warn("Interrupted agent terminal commands require manual review", {
          count: interruptedAgentLifecycleCommandsRecovered
        });
      }
      if (interruptedWorkspaceNoteProjectionsRecovered > 0) {
        logger.warn("Interrupted workspace note projections were queued again", {
          count: interruptedWorkspaceNoteProjectionsRecovered
        });
      }
      if (interruptedWorkspaceConnectionProjectionsRecovered > 0) {
        logger.warn("Interrupted workspace connection projections were queued again", {
          count: interruptedWorkspaceConnectionProjectionsRecovered
        });
      }
      const terminalSupervisor = processSupervisor;
      const loadOrchestratorCapabilities = async () =>
        deriveAgentRuntimeCapabilities(await inspectRuntimeAdapters(), new Date().toISOString());
      const orchestratorDraftDriver =
        workflowDraftStore === null
          ? null
          : new OrchestratorDraftDriver({
              store: workflowDraftStore,
              loadCapabilities: loadOrchestratorCapabilities,
              loadAgents: async () => ({ descriptors: await agentDescriptors.refresh() })
            });
      orchestratorDraftDriver?.onDraftChanged((draft, sessionId) => {
        liveOrchestratorSessionService?.onDraftChanged(sessionId, draft);
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(WORKFLOW_DRAFT_UPDATED_EVENT_CHANNEL, draft);
        }
      });
      terminalSupervisor.subscribe((event) => {
        const sessionId = event.type === "session.state" ? event.session.id : event.sessionId;
        if (sessionAccess.get(sessionId) === null) return;
        // A real orchestrator session's raw output composes the draft (ghost nodes). Untrusted:
        // only schema-valid composition actions the reducer accepts change state.
        if (
          event.type === "session.output" &&
          orchestratorDraftDriver?.isAttached(event.sessionId) === true
        ) {
          void orchestratorDraftDriver.ingest(event.sessionId, event.data);
        }
        // A worker session's output is reconciled against its dispatch: only a structured TaskResult
        // completes it (idle never does). ingest ignores sessions it has not bound.
        if (event.type === "session.output" && activationCoordinator !== null) {
          activationCoordinator.ingest(event.sessionId, event.data);
        }
        if (
          event.type === "session.state" &&
          ["succeeded", "failed", "cancelled", "interrupted"].includes(event.session.state)
        ) {
          if (liveOrchestratorSessionService?.isOrchestratorSession(event.session.id) === true) {
            liveOrchestratorSessionService.onTerminalState(
              event.session.id,
              event.session.state as "succeeded" | "failed" | "cancelled" | "interrupted"
            );
          }
          agentMessageStore?.markSessionOffline(event.session.id);
          // Staged copies of the user's notes and attachments must not outlive the process that
          // could read them. Best-effort here; the startup sweep is the durable backstop for a
          // crash that never delivers this event.
          const access = sessionAccess.get(event.session.id);
          if (access !== null) {
            void projects
              .get(access.projectId)
              .then((project) => {
                if (project !== null) {
                  releaseTerminalContext({
                    projectRoot: project.canonicalRootPath,
                    sessionId
                  });
                }
              })
              .catch(() => {
                logger.warn("Staged terminal context could not be released");
              });
          }
        }
        const safeEvent = sanitizeTerminalEvent(event, sessionAccess);
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(TERMINAL_EVENT_CHANNEL, safeEvent);
        }
      });
      // A leaking agent should cost you the agent, not the shell you were watching it in. Off unless
      // the host asks for it: killing a person's process is not something to start doing unasked.
      if (runtimeLimits.maxProcessMemoryBytesPerSession > 0) {
        terminalMemoryMonitor = new MemoryLimitMonitor({
          sessions: () =>
            terminalSupervisor
              .listSessions()
              .filter((session) => session.state === "running" && session.processId !== null)
              .map((session) => ({
                sessionId: session.id,
                processId: session.processId as number
              })),
          reader: new PlatformProcessMemoryReader(runtimePlatform()),
          killer: new PlatformProcessTreeKiller(),
          limitBytes: runtimeLimits.maxProcessMemoryBytesPerSession,
          onBreach: (breach) => {
            logger.warn("Terminal process exceeded the memory limit and was stopped", {
              sessionId: breach.sessionId,
              residentBytes: breach.residentBytes,
              limitBytes: breach.limitBytes
            });
            // Surfaced as a session error rather than left as a terminal that mysteriously went
            // quiet. The terminal itself keeps running.
            const event = sanitizeTerminalEvent(
              {
                type: "session.error",
                sessionId: breach.sessionId,
                code: "terminal_memory_limit",
                message: `Um processo deste terminal passou de ${String(Math.round(breach.limitBytes / (1024 * 1024)))} MB e foi encerrado. O terminal continua aberto.`
              },
              sessionAccess
            );
            for (const window of BrowserWindow.getAllWindows()) {
              window.webContents.send(TERMINAL_EVENT_CHANNEL, event);
            }
          }
        });
        terminalMemoryMonitor.start();
      }
      const terminalServices = {
        supervisor: terminalSupervisor,
        projects,
        adapters,
        detector: new PathExecutableDetector(),
        commandRunner: new ExecFileCommandRunner(),
        environment: createAllowedEnvironment(process.env, {
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          FORCE_COLOR: "1"
        }),
        platform: runtimePlatform(),
        sessionAccess,
        maxActiveSessionsPerProject: runtimeLimits.maxActiveSessionsPerProject,
        ...(compazioCli === null ? {} : { cliBridge: { binDirectory: compazioCli.binDirectory } }),
        contextStaging: {
          stage: (input: {
            readonly workspaceId: string;
            readonly nodeId: string;
            readonly projectRoot: string;
            readonly sessionId: string;
          }) => {
            if (workspaceContextStore === null) {
              throw new Error("Workspace context runtime is unavailable");
            }
            return stageTerminalContext({ ...input, contextStore: workspaceContextStore });
          }
        },
        agentEndpoints: agentMessageStore,
        agentIdentities: {
          ensureAgentIdentity: (input: {
            readonly workspaceId: string;
            readonly nodeId: string;
          }) => {
            const { workspaceId, nodeId } = input;
            if (localIdentityStore === null) {
              throw new Error("Local identity runtime is unavailable");
            }
            localIdentityStore.ensureIdentity({
              kind: "agent",
              subjectId: `workspace:${workspaceId}:agent:${nodeId}`,
              label: `Canvas agent ${nodeId}`
            });
          }
        }
      } as const;
      registerTerminalIpc(privilegedIpc, terminalServices);
      if (orchestratorDraftDriver !== null) {
        liveOrchestratorSessionService = new OrchestratorSessionService({
          launcher: {
            // Planning has no visible terminal anymore. It is a single read-only pipe turn with a
            // bounded result, so automatic mode cannot get stuck at an idle PowerShell prompt.
            launch: async () => ({
              sessionId: `automatic-planner-${globalThis.crypto.randomUUID()}`
            }),
            write: async () => undefined,
            cancel: async () => undefined
          },
          loadCapabilities: loadOrchestratorCapabilities,
          planner: {
            compose: async (input) => {
              if (automaticModeService === null) {
                throw new Error("Automatic planning is still initializing.");
              }
              const mode =
                input.executionProfile === "economy"
                  ? "economic"
                  : input.executionProfile === "maximum"
                    ? "high-performance"
                    : "standard";
              const recovered =
                input.reuseRecentPlan === true
                  ? automaticModeService.recoverRecentDraft({
                      workspaceId: input.workspaceId,
                      objective: input.objective,
                      mode,
                      orchestratorAdapter: input.runtimeId as AgentAdapterId
                    })
                  : null;
              if (recovered !== null) {
                return reconcileWorkflowDraftWithCanvasTeam(recovered, input.canvas);
              }
              const planned = await automaticModeService.create({
                workspaceId: input.workspaceId,
                objective: input.objective,
                mode,
                orchestratorAdapter: input.runtimeId as AgentAdapterId,
                acceptanceCriteria: []
              });
              const draft = automaticModeService.draft(planned.automaticRunId);
              if (draft === null) {
                throw new Error(planned.issues[0] ?? "The agent did not return a valid workflow.");
              }
              // Automatic composition is one layer of the same hybrid canvas, not a detached team.
              // Keep the model's task breakdown, but deterministically reuse every compatible agent
              // and role the user already configured and preserve their explicit connections.
              return reconcileWorkflowDraftWithCanvasTeam(draft, input.canvas);
            }
          }
        });
        liveOrchestratorSessionService.onWorkflowDraft((sessionId, draft) =>
          orchestratorDraftDriver.acceptDraft(sessionId, draft)
        );
        registerOrchestratorSessionIpc(privilegedIpc, {
          service: liveOrchestratorSessionService,
          driver: orchestratorDraftDriver,
          publishComposition: (composition) => {
            for (const window of BrowserWindow.getAllWindows()) {
              window.webContents.send(ORCHESTRATOR_COMPOSITION_UPDATED_EVENT_CHANNEL, composition);
            }
          }
        });
      }
      // Activation: on approval the scheduler dispatches workers. Each dispatch spawns a worker PTY,
      // binds it to its task, and primes it with the worker contract (which requires a TaskResult).
      activationCoordinator = new ActivationCoordinator({
        newId: () => globalThis.crypto.randomUUID(),
        onDispatch: (dispatch: WorkerDispatch) => {
          const draft = activeApprovedDraft;
          const node = draft?.nodes.find((entry) => entry.id === dispatch.taskId);
          if (draft === null || node === undefined) return;
          void (async () => {
            try {
              const projectId = workspaceRepository?.get(draft.workspaceId)?.projectId;
              if (projectId === undefined) return;
              const session = await createTerminalSession(
                {
                  projectId,
                  adapterId: dispatch.runtimeId as TerminalCreateRequest["adapterId"],
                  cols: 120,
                  rows: 32
                },
                terminalServices
              );
              activationCoordinator?.bindWorkerSession(dispatch.taskId, session.id);
              await terminalSupervisor.write(
                session.id,
                `${buildWorkerPrompt({
                  node,
                  taskId: dispatch.taskId,
                  dispatchId: dispatch.dispatchId,
                  objective: draft.objective
                })}\n`
              );
            } catch (error: unknown) {
              logger.error("Failed to dispatch a workflow worker", {
                taskId: dispatch.taskId,
                reason: error instanceof Error ? error.message : "unknown"
              });
            }
          })();
        },
        // Increment A: the ONLY new approval path. It delegates run creation to the single live
        // WorkflowRunRuntime; it never instantiates a runtime, scheduler or store here.
        ...(workflowActivationStore === null
          ? {}
          : {
              materialization: {
                ledger: workflowActivationStore,
                // Agent availability is read at approval time, so a node can only start on an agent
                // that is genuinely installed, executable and capable right now.
                agents: async () => ({ descriptors: await agentDescriptors.refresh() }),
                resolveProjectRoot: async (workspaceId: string) => {
                  const workspace = workspaceRepository?.get(workspaceId) ?? null;
                  if (workspace === null) return null;
                  const project = await projects.get(workspace.projectId);
                  return project?.canonicalRootPath ?? null;
                },
                starter: {
                  startMaterializedWorkflow: async (input) => {
                    const functionCheckpoint: WorkflowExecutionCheckpointReference = {
                      checkpointId: globalThis.crypto.randomUUID(),
                      snapshotId: globalThis.crypto.randomUUID(),
                      sha256: input.definitionSha256,
                      createdAt: new Date().toISOString()
                    };
                    const context: WorkflowRunExecutionContext = {
                      workspaceId: input.workspaceId,
                      agentNodeId: input.agentNodeId,
                      task: input.task,
                      contractId: null,
                      profileVersion: 1,
                      missionVersion: null,
                      memoryVersion: null,
                      contractVersion: null,
                      functionCheckpoint,
                      deliveryCheckpoint: null
                    };
                    const handle = workflowRuntime.startMaterialized({
                      workflow: input.workflow,
                      target: { root: input.root, agentNodeId: input.agentNodeId },
                      prepareRun: (runId) =>
                        activeWorkflowNodePromptStore.putMany(runId, input.nodePrompts),
                      executionContext: {
                        context,
                        createDeliveryCheckpoint: async () => ({
                          checkpointId: globalThis.crypto.randomUUID(),
                          snapshotId: globalThis.crypto.randomUUID(),
                          sha256: input.definitionSha256,
                          createdAt: new Date().toISOString()
                        })
                      }
                    });
                    return workflowRuntime.get(handle.runId);
                  }
                }
              }
            })
      });
      compassoRuntime = new CompassoRuntime({
        terminal: terminalSupervisor,
        adapters,
        projectLeases: runtimeProjectLeaseStore,
        lifecycle: runtimeLifecycleStore,
        workflowRunDispatcher,
        maxConcurrentDeliveriesPerProject: runtimeLimits.maxConcurrentDeliveriesPerProject,
        agentMessages: agentMessageStore,
        agentSpawns: agentSpawnStore,
        agentLifecycle: agentLifecycleStore,
        artifacts: workspaceArtifactStore,
        notes: workspaceNoteStore,
        connections: workspaceConnectionStore,
        activity: workspaceActivityStore,
        observeActivity: (onChange) => observeWorkspaceDatabase(databaseFilename, onChange),
        startAgent: (spawn) =>
          createTerminalSession(
            {
              projectId: spawn.projectId,
              adapterId: spawn.adapterId,
              endpoint: { workspaceId: spawn.workspaceId, nodeId: spawn.nodeId },
              cols: 120,
              rows: 30
            },
            terminalServices
          ),
        /**
         * Brings a reassigned agent back under its new responsibility. It reuses the same terminal
         * path a fresh agent takes, so the role reaches it through the staged context rather than
         * through a second, divergent way of starting an agent.
         */
        restartAgent: async (command) => {
          const agent = agentMessageStore
            ?.listAgents(command.workspaceId)
            .find((entry) => entry.nodeId === command.targetNodeId);
          if (agent === undefined) return null;
          // Narrowed deliberately: only an agent runtime the product can launch is restartable, and
          // a shell terminal has no responsibility to come back under.
          const adapterId = spawnAgentAdapterIdSchema.parse(agent.adapterId);
          return createTerminalSession(
            {
              projectId: command.projectId,
              adapterId,
              endpoint: { workspaceId: command.workspaceId, nodeId: command.targetNodeId },
              cols: 120,
              rows: 30
            },
            terminalServices
          );
        },
        releaseSessionContext: (sessionId) => {
          const access = sessionAccess.get(sessionId);
          if (access === null) return;
          void projects
            .get(access.projectId)
            .then((project) => {
              if (project !== null) {
                releaseTerminalContext({ projectRoot: project.canonicalRootPath, sessionId });
              }
            })
            .catch(() => {
              logger.warn("Staged terminal context could not be released");
            });
        },
        publishAgentSpawn: (event) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(AGENT_SPAWN_EVENT_CHANNEL, event);
          }
        },
        publishAgentLifecycle: (event) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(AGENT_LIFECYCLE_EVENT_CHANNEL, event);
          }
        },
        publishArtifact: (event) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(WORKSPACE_ARTIFACT_EVENT_CHANNEL, event);
          }
        },
        publishNote: (event) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(WORKSPACE_NOTE_EVENT_CHANNEL, event);
          }
        },
        publishConnection: (event) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(WORKSPACE_CONNECTION_EVENT_CHANNEL, event);
          }
        },
        publishActivity: (event) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(WORKSPACE_ACTIVITY_EVENT_CHANNEL, event);
          }
        }
      });
      const publishProjectRuntimeRegistration = (projectRoot: string): void => {
        registerCompassoRuntime({
          projectRoot,
          databasePath: databaseFilename,
          endpoint: {
            url: localAuthAddress.url,
            identityId: cliCredential.identityId,
            token: cliCredential.token,
            nonce: cliCredential.nonce
          }
        });
      };
      registerProjectRuntime = async (projectRoot: string): Promise<void> => {
        const project = (await projects.list()).find(
          (candidate) => candidate.canonicalRootPath === projectRoot
        );
        if (project === undefined) {
          throw new Error("Compazio Runtime could not resolve the local project");
        }
        const acquired = compassoRuntime?.acquireProject(project.id) ?? false;
        try {
          publishProjectRuntimeRegistration(projectRoot);
        } catch {
          if (acquired) compassoRuntime?.releaseProject(project.id);
          throw new Error("Compazio runtime could not be registered for this project");
        }
      };
      const knownProjects = await projects.list();
      let runtimeConflict = false;
      let runtimeAvailable = true;
      for (const project of knownProjects) {
        try {
          compassoRuntime.acquireProject(project.id);
        } catch (error: unknown) {
          runtimeAvailable = false;
          runtimeConflict = runtimeConflict || error instanceof RuntimeProjectConflictError;
          logger.warn("Compazio Runtime could not acquire a local project lease");
        }
      }
      if (!runtimeAvailable) {
        compassoRuntime.dispose();
        logger.warn(
          runtimeConflict
            ? "Compazio Runtime delivery is disabled because another runtime owns a project"
            : "Compazio Runtime delivery is disabled because project coordination is unavailable"
        );
      } else {
        for (const project of knownProjects) {
          try {
            publishProjectRuntimeRegistration(project.canonicalRootPath);
          } catch {
            logger.warn("Compazio runtime registration could not be refreshed for a local project");
          }
        }
        compassoRuntime.start();
      }
      installRendererContentSecurityPolicy(process.env.ELECTRON_RENDERER_URL !== undefined);
      createMainWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createMainWindow();
        }
      });
    })
    .catch((error: unknown) => {
      logger.error("Desktop startup failed", error);
      app.exit(1);
    });

app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window !== undefined) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.on("before-quit", (event) => {
  if (hostShutdownStarted) return;
  event.preventDefault();
  hostShutdownStarted = true;
  void shutdownHost().finally(() => app.quit());
});

/**
 * The single ordered host shutdown. Nothing durable may be closed while a write is still in flight, so
 * the sequence is: stop accepting new work → unwind the automatic sessions → drain every workflow run
 * until its terminal transition is committed → close the processes and the local endpoint → only then
 * close the stores and the database. Each stage is awaited; a failure is reported and never skips the
 * remaining stages, because a half-closed host would leak processes and file handles.
 */
async function shutdownHost(): Promise<void> {
  releaseAutomaticIpc?.();
  releaseAutomaticIpc = null;
  // Automatic sessions are aborted and their loops unwound before the runs they drive are drained.
  await settle("Automatic mode shutdown failed", automaticModeService?.close());
  automaticModeService = null;
  // The runtime refuses new runs, interrupts what is still in flight, and resolves only once every
  // terminal state, attempt, node state and terminal event reached SQLite.
  await settle("Workflow runtime shutdown failed", workflowRunRuntime?.close());
  workflowRunRuntime = null;
  await settle("Terminal shutdown failed", processSupervisor?.shutdown());
  try {
    compassoRuntime?.recordHostShutdown();
  } catch (error: unknown) {
    logger.error("Compazio runtime shutdown could not be recorded", error);
  }
  compassoRuntime?.dispose();
  await settle("Local authentication endpoint shutdown failed", localAuthEndpoint?.close());
  closeLocalStores();
}

async function settle(message: string, work: Promise<unknown> | undefined): Promise<void> {
  if (work === undefined) return;
  try {
    await work;
  } catch (error: unknown) {
    logger.error(message, error);
  }
}

/** Closes every local store. Called only after every in-flight write has been drained. */
function closeLocalStores(): void {
  canvasRepository?.close();
  canvasHandoffRepository?.close();
  automaticRunStore?.close();
  automaticRunStore = null;
  releaseWorkflowRunEventSubscription?.();
  releaseWorkflowRunEventSubscription = null;
  workflowRunStore?.close();
  workflowNodePromptStore?.close();
  workflowRunCommandStore?.close();
  workflowRunTargetStore?.close();
  orchestrationProposalStore?.close();
  executionContextStore?.close();
  workflowArtifactRegistry?.close();
  gitStore?.close();
  cloudSyncStore?.close();
  runtimeSessionStore?.close();
  workspaceRepository?.close();
  appSettingsRepository?.close();
  agentMessageStore?.close();
  agentSpawnStore?.close();
  workspaceArtifactStore?.close();
  workspaceNoteStore?.close();
  workspaceConnectionStore?.close();
  workspaceHandoffStore?.close();
  workspaceActivityStore?.close();
  workspaceIncidentStore?.close();
  runtimeProjectLeaseStore?.close();
  runtimeLifecycleStore?.close();
  localIdentityStore?.close();
  policyEngine?.close();
  canvasRepository = null;
  canvasHandoffRepository = null;
  workflowRunStore = null;
  workflowNodePromptStore = null;
  workflowRunCommandStore = null;
  workflowRunTargetStore = null;
  orchestrationProposalStore = null;
  executionContextStore = null;
  workflowArtifactRegistry = null;
  gitStore = null;
  cloudSyncStore = null;
  runtimeSessionStore = null;
  workspaceRepository = null;
  appSettingsRepository = null;
  agentMessageStore = null;
  agentSpawnStore = null;
  workspaceArtifactStore = null;
  workspaceNoteStore = null;
  workspaceConnectionStore = null;
  workspaceHandoffStore = null;
  workspaceActivityStore = null;
  compassoRuntime = null;
  runtimeProjectLeaseStore = null;
  runtimeLifecycleStore = null;
  localIdentityStore = null;
  policyEngine = null;
  localAuthEndpoint = null;
  processSupervisor = null;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: unknown) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function runtimePlatform(): "win32" | "darwin" | "linux" {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error(`Unsupported runtime platform: ${process.platform}`);
}

function isSmokeRestoredState(value: unknown): value is {
  readonly nodeCount: number;
  readonly templateCount: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodeCount" in value &&
    typeof value.nodeCount === "number" &&
    "templateCount" in value &&
    typeof value.templateCount === "number"
  );
}

function installRendererContentSecurityPolicy(isDevelopment: boolean): void {
  const policy = createRendererContentSecurityPolicy(isDevelopment);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== "mainFrame") {
      callback(
        details.responseHeaders === undefined ? {} : { responseHeaders: details.responseHeaders }
      );
      return;
    }
    callback({
      responseHeaders: withRendererContentSecurityPolicy(details.responseHeaders ?? {}, policy)
    });
  });
}
