import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { app, BrowserWindow, dialog, ipcMain, Notification, session } from "electron";

import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";
import {
  V2_FILE_EVENT_CHANNEL,
  V2_OPERATIONAL_NAVIGATE_CHANNEL,
  V2_PORTAL_DOWNLOAD_REQUEST_CHANNEL,
  V2_PORTAL_EVENT_CHANNEL
} from "@forgedeck/compazio-v2-domain";
import {
  AgentRuntime,
  RoleInjectionService,
  V2ProcessSupervisor
} from "@forgedeck/compazio-v2-runtime";
import {
  PipeProcessFactory,
  PlatformProcessTreeKiller,
  PtyProcessFactory,
  TransportProcessFactory
} from "@forgedeck/terminal";
import { readFeatureFlags } from "@forgedeck/config";

import {
  createRendererContentSecurityPolicy,
  withRendererContentSecurityPolicy
} from "../../main/content-security-policy";
import { publishV2OperationalEvents, publishV2TerminalEvents, registerV2Ipc } from "./v2-ipc";
import { runFinalProductJourney, runV2ElectronSmoke } from "./e2e/v2-smoke";
import { runPortalIntegration } from "./e2e/portal-integration";
import { runPortalElectronSmoke } from "./e2e/portal-smoke";
import { runPortalRealAgents } from "./e2e/portal-real-agents";
import { runPortalMcpRealAgents } from "./e2e/portal-mcp-real-agents";
import { V2OrchestratorBridge } from "./orchestrator-bridge";
import { V2OperationalService } from "./operational-service";
import { V2WorkspaceService } from "./workspace-service";
import { createSafeV2Diagnostics } from "./diagnostics";
import { FileSystemService } from "./file-system-service";
import { GitService } from "./git-service";
import { PortalRuntimeManager } from "./portal-runtime-manager";
import { CommunityEntitlementService } from "./community-entitlement-service";
import { UpdateService } from "./update-service";
import { trustedRendererIpc } from "../../main/trusted-renderer-ipc";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
let workspaceService: V2WorkspaceService | null = null;
let orchestratorBridge: V2OrchestratorBridge | null = null;
let releaseTerminalEvents: (() => void) | null = null;
let releaseOperationalEvents: (() => void) | null = null;
let fileSystemService: FileSystemService | null = null;
let portalRuntimeManager: PortalRuntimeManager | null = null;
let updateService: UpdateService | null = null;
let mainWindow: BrowserWindow | null = null;
let shutdownStarted = false;

// The isolated V2 entrypoint must retain the installed product identity even when Electron is
// launched outside electron-builder (development, smoke and diagnostics).
app.setName("Compazio Community");
app.setAppUserModelId("com.compazio.community");

/**
 * Two processes writing the same user data is the one concurrency the per-path lock cannot cover:
 * it is in-process only. A second launch therefore hands its arguments to the running window and
 * exits instead of racing it on agents.json.
 *
 * Isolated harness runs are exempt because each one owns a private, temporary user data directory,
 * so they cannot collide with the installed app or with each other.
 */
const ownsUserData =
  process.env.COMPAZIO_V2_DATA_DIR !== undefined || app.requestSingleInstanceLock();
if (!ownsUserData) {
  app.quit();
}

// Keep display-scale coverage deterministic without changing the installed app. The smoke
// runner opts into this switch before Electron is ready; production windows use the native
// Windows scale unchanged.
if (process.env.COMPAZIO_V2_SMOKE === "true") {
  const scale = Number(process.env.COMPAZIO_V2_SMOKE_SCALE);
  if (Number.isFinite(scale) && scale >= 0.8 && scale <= 2) {
    app.commandLine.appendSwitch("force-device-scale-factor", String(scale));
  }
}

function createWindow(): BrowserWindow {
  if (mainWindow !== null && !mainWindow.isDestroyed()) return mainWindow;
  const smokeSize = (name: "WIDTH" | "HEIGHT", fallback: number): number => {
    if (process.env.COMPAZIO_V2_SMOKE !== "true") return fallback;
    const value = Number(process.env[`COMPAZIO_V2_SMOKE_${name}`]);
    return Number.isFinite(value) && value >= 640 ? Math.round(value) : fallback;
  };
  const developmentIcon = join(currentDirectory, "../../build/icon.png");
  const window = new BrowserWindow({
    title: "Compazio",
    width: smokeSize("WIDTH", 1280),
    height: smokeSize("HEIGHT", 820),
    minWidth: 900,
    minHeight: 620,
    ...(existsSync(developmentIcon) ? { icon: developmentIcon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Electron can throttle requestAnimationFrame to roughly one frame per second when the
      // smoke window loses focus on Windows. The production default remains untouched; the
      // deterministic smoke fixture explicitly opts out of that background throttling.
      backgroundThrottling:
        process.env.COMPAZIO_V2_SMOKE !== "true" &&
        process.env.COMPAZIO_FINAL_PRODUCT_JOURNEY !== "true",
      preload: join(currentDirectory, "../preload/index.cjs")
    }
  });
  mainWindow = window;
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("Compazio V2 preload failed", {
      preloadPath,
      reason: error instanceof Error ? error.message : String(error)
    });
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("Compazio V2 renderer failed to load", {
      errorCode,
      errorDescription,
      validatedURL
    });
  });
  if (process.env.COMPAZIO_V2_DEBUG_RENDERER === "true") {
    window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.error("Compazio V2 renderer console", { level, message, line, sourceId });
    });
  }
  window.on("minimize", () => portalRuntimeManager?.setWindowState({ minimized: true }));
  window.on("restore", () => portalRuntimeManager?.setWindowState({ minimized: false }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl === undefined)
    void window.loadFile(join(currentDirectory, "../renderer/index.html"), {
      ...(process.env.COMPAZIO_V2_SMOKE_DOM_TERMINAL === "true"
        ? { query: { terminalRenderer: "dom" } }
        : {})
    });
  else void window.loadURL(rendererUrl);
  return window;
}

function installContentSecurityPolicy(): void {
  const policy = createRendererContentSecurityPolicy(
    process.env.ELECTRON_RENDERER_URL !== undefined
  );
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: withRendererContentSecurityPolicy(details.responseHeaders, policy)
    });
  });
}

void app
  .whenReady()
  .then(async () => {
    const storageRoot =
      process.env.COMPAZIO_V2_DATA_DIR ?? join(app.getPath("userData"), "compazio", "v2");
    const featureFlags = readFeatureFlags(process.env);
    const supervisor = new V2ProcessSupervisor(
      new TransportProcessFactory({ pty: new PtyProcessFactory(), pipe: new PipeProcessFactory() }),
      { treeKiller: new PlatformProcessTreeKiller() }
    );
    // Every fallback read is reported rather than swallowed: the workspace still opens, and the
    // renderer is told which copy answered so the person knows what happened to their data.
    const recoveries: {
      readonly file: string;
      readonly source: string;
      readonly recoveredFrom: string;
      readonly reason: string;
    }[] = [];
    const repository = new V2WorkspaceRepository({
      rootDirectory: storageRoot,
      onRecovery: (event) => {
        recoveries.push(event);
        console.warn("Compazio V2 recuperou um arquivo de estado", {
          file: event.file,
          source: event.source,
          recoveredFrom: event.recoveredFrom
        });
      }
    });
    // Temporaries left by a process that died mid-write are dropped once, at startup, while nothing
    // else is running. A recent temporary may belong to a live write and is never touched.
    void repository
      .pruneAbandonedTemporaries()
      .then((removed) => {
        if (removed.length > 0)
          console.warn("Compazio V2 removeu temporários abandonados", { count: removed.length });
      })
      .catch((error: unknown) => {
        console.warn("Compazio V2 não conseguiu limpar temporários abandonados", error);
      });
    const entitlement = new CommunityEntitlementService();
    const agents = new AgentRuntime({
      store: repository,
      roleInjection: new RoleInjectionService(join(storageRoot, "role-sessions")),
      environment: process.env
    });
    workspaceService = new V2WorkspaceService({
      repository,
      supervisor,
      agents,
      entitlement,
      notesAsMarkdown: true
    });
    const operations = new V2OperationalService({
      repository,
      workspaces: workspaceService,
      notify: (payload) => {
        if (!Notification.isSupported()) return false;
        try {
          const notification = new Notification({
            title: payload.title,
            body: payload.body,
            silent: false
          });
          notification.on("click", () => {
            const target = BrowserWindow.getAllWindows()[0] ?? createWindow();
            if (target.isMinimized()) target.restore();
            target.show();
            target.focus();
            target.webContents.send(V2_OPERATIONAL_NAVIGATE_CHANNEL, {
              workspaceId: payload.workspaceId,
              ...(payload.runId === undefined ? {} : { runId: payload.runId }),
              ...(payload.terminalId === undefined ? {} : { terminalId: payload.terminalId }),
              openInspector: true
            });
          });
          notification.show();
          return true;
        } catch {
          return false;
        }
      }
    });
    fileSystemService = new FileSystemService({
      workspaceRoot: async (workspaceId) => {
        if (workspaceService === null)
          throw new Error("O serviço de workspaces não está disponível.");
        return workspaceService.workingDirectory(workspaceId);
      },
      onEvent: (event) => {
        for (const current of BrowserWindow.getAllWindows())
          current.webContents.send(V2_FILE_EVENT_CHANNEL, event);
        void operations
          .recordOperationalEvent({
            workspaceId: event.workspaceId,
            type: event.type === "deleted" ? "file.external-change" : "file.external-change",
            target: event.treeNodeId,
            metadata: { kind: event.type }
          })
          .catch(() => undefined);
      }
    });
    const git = new GitService({
      workspaceRoot: async (workspaceId) => {
        if (workspaceService === null)
          throw new Error("O serviço de workspaces não está disponível.");
        return workspaceService.workingDirectory(workspaceId);
      }
    });
    portalRuntimeManager = new PortalRuntimeManager({
      getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
      tempDirectory: join(app.getPath("temp"), "compazio-v2-portals"),
      downloadDirectory: app.getPath("downloads"),
      testHooks: process.env.COMPAZIO_V2_PORTAL_TEST_HOOKS === "true",
      persist: async (workspaceId, portalId, patch) => {
        if (workspaceService !== null)
          await workspaceService.updatePortal(workspaceId, portalId, patch);
      },
      // The download dialog belongs to Compazio: the offer goes to the renderer and the answer
      // comes back through the typed channel before a single byte reaches the disk.
      askDownload: (offer) => {
        for (const current of BrowserWindow.getAllWindows())
          current.webContents.send(V2_PORTAL_DOWNLOAD_REQUEST_CHANNEL, offer);
      },
      onEvent: (type, metadata) => {
        const portalId = typeof metadata.portalId === "string" ? metadata.portalId : "portal";
        for (const current of BrowserWindow.getAllWindows())
          current.webContents.send(V2_PORTAL_EVENT_CHANNEL, { type, ...metadata });
        void operations
          .recordOperationalEvent({
            workspaceId: String(metadata.workspaceId ?? "unknown"),
            type: "file.external-change",
            target: portalId,
            metadata: { portalEvent: type }
          })
          .catch(() => undefined);
      }
    });
    orchestratorBridge = new V2OrchestratorBridge({
      workspaces: workspaceService,
      agents,
      operations,
      git,
      portals: portalRuntimeManager,
      storageDirectory: storageRoot,
      nodeExecutable: process.execPath,
      orchestratorMode: featureFlags.orchestratorMode,
      notify: ({ title, body }) => {
        if (!Notification.isSupported()) return;
        try {
          new Notification({ title, body }).show();
        } catch {
          // A platform notification failure cannot take ownership away from the process supervisor.
        }
      }
    });
    await orchestratorBridge.start();
    workspaceService.setOrchestratorBridge(orchestratorBridge);
    // Only the Windows NSIS updater is validated for Beta 0.1. Other platforms continue to use
    // native/manual release assets until their native update paths are separately approved.
    updateService = new UpdateService({
      packaged:
        app.isPackaged && process.platform === "win32" && process.env.COMPAZIO_V2_SMOKE !== "true",
      channel: process.env.COMPAZIO_UPDATE_CHANNEL ?? "beta",
      shutdown: async () => {
        // Revoke the provider's MCP capability and loopback transports before asking its process
        // to exit. That leaves no live agent waiting on a local connection during update/reload.
        await (orchestratorBridge?.shutdown() ?? Promise.resolve());
        await (workspaceService?.shutdown() ?? Promise.resolve());
        await (portalRuntimeManager?.shutdown() ?? Promise.resolve());
      },
      // Do not restart while any terminal/TeamRun process is still active. The explicit install
      // action becomes available again after the user stops the active work.
      canInstall: () => supervisor.diagnostics().activeSessionCount === 0
    });
    updateService.initialize();
    registerV2Ipc(
      trustedRendererIpc(ipcMain, () => mainWindow?.webContents ?? null),
      {
        workspaces: workspaceService,
        agents,
        operations,
        files: fileSystemService,
        git,
        portals: portalRuntimeManager,
        entitlement,
        updates: updateService,
        orchestrator: orchestratorBridge,
        chooseDirectory: async () => {
          // The Electron acceptance harness cannot automate the native chooser. It may only supply
          // its own temporary fixture directory, and only while the explicit smoke phase is active.
          // Production never reads this branch.
          if (process.env.COMPAZIO_V2_SMOKE === "true")
            return process.env.COMPAZIO_V2_SMOKE_WORKSPACE ?? null;
          if (process.env.COMPAZIO_FINAL_PRODUCT_JOURNEY === "true")
            return process.env.COMPAZIO_FINAL_PROJECT_DIRECTORY ?? null;
          const result = await dialog.showOpenDialog({
            properties: ["openDirectory", "createDirectory"]
          });
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        // O seletor do sistema é a autorização: quem escolhe o arquivo é a pessoa, no explorador dela.
        chooseFiles: async (defaultPath: string) => {
          const result = await dialog.showOpenDialog({
            title: "Trazer arquivos para o canvas",
            defaultPath,
            properties: ["openFile", "multiSelections"],
            filters: [
              {
                name: "Documentos, imagens e mídia",
                extensions: [
                  "md",
                  "markdown",
                  "txt",
                  "json",
                  "yml",
                  "yaml",
                  "csv",
                  "log",
                  "png",
                  "jpg",
                  "jpeg",
                  "webp",
                  "gif",
                  "svg",
                  "pdf",
                  "mp4",
                  "webm",
                  "mov"
                ]
              },
              { name: "Todos os arquivos", extensions: ["*"] }
            ]
          });
          return result.canceled ? [] : result.filePaths;
        },
        exportDiagnostics: async (workspaceId) => {
          if (orchestratorBridge === null || workspaceService === null) return null;
          const result = await dialog.showSaveDialog({
            title: "Exportar diagnóstico do Compazio",
            defaultPath: `compazio-diagnostico-${new Date().toISOString().slice(0, 10)}.json`,
            filters: [{ name: "JSON", extensions: ["json"] }]
          });
          const path = result.filePath;
          if (result.canceled || path === undefined) return null;
          const contents = await createSafeV2Diagnostics(workspaceId, {
            version: app.getVersion(),
            workspaces: workspaceService,
            operations,
            agents,
            supervisor,
            bridge: orchestratorBridge
          });
          await writeFile(path, contents, "utf8");
          return path;
        }
      }
    );
    releaseTerminalEvents = publishV2TerminalEvents(workspaceService);
    releaseOperationalEvents = publishV2OperationalEvents(operations);
    installContentSecurityPolicy();
    const window = createWindow();
    if (process.env.COMPAZIO_V2_SMOKE === "true") {
      void runV2ElectronSmoke(window)
        .then(() => {
          // The AppImage launcher can retain a wrapper process after Electron's normal
          // before-quit sequence completes. Packaged smoke must report its result to the
          // parent instead of leaving that launcher orphaned.
          if (process.platform === "linux" && process.env.COMPAZIO_V2_PACKAGED_SMOKE === "true")
            app.exit(0);
          else app.quit();
        })
        .catch((error: unknown) => {
          console.error("Compazio V2 smoke failed", error);
          app.exit(1);
        });
    }
    if (process.env.COMPAZIO_FINAL_PRODUCT_JOURNEY === "true") {
      void runFinalProductJourney(window)
        .then(() => {
          if (process.env.COMPAZIO_FINAL_LEAVE_OPEN !== "true") app.quit();
        })
        .catch((error: unknown) => {
          console.error("Compazio final product journey failed", error);
          const artifactsDirectory = process.env.COMPAZIO_FINAL_ARTIFACTS_DIRECTORY;
          const errorText =
            error instanceof Error
              ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
              : String(error);
          const persistError =
            artifactsDirectory === undefined
              ? Promise.resolve()
              : writeFile(join(artifactsDirectory, "journey-error.txt"), errorText, "utf8").catch(
                  (writeError: unknown) => {
                    console.error("Could not persist final journey failure", writeError);
                  }
                );
          void persistError.finally(() => app.exit(1));
        });
    }
    // The Portal integration owns its own workspace and manager: it exercises the native runtime
    // against the local fixture without touching the application's data directory.
    // Opt-in: starts real agent CLIs and therefore spends the user's own provider credits.
    if (process.env.COMPAZIO_V2_PORTAL_REAL_AGENTS === "true") {
      void runPortalRealAgents(window)
        .then(() => app.exit(process.exitCode ?? 0))
        .catch((error: unknown) => {
          console.error("Compazio V2 portal real agents failed", error);
          app.exit(1);
        });
    }
    if (process.env.COMPAZIO_V2_MCP_REAL_AGENTS === "true") {
      void runPortalMcpRealAgents(window)
        .then(() => app.exit(process.exitCode ?? 0))
        .catch((error: unknown) => {
          console.error("Compazio V2 MCP real agents failed", error);
          app.exit(1);
        });
    }
    if (process.env.COMPAZIO_V2_PORTAL_SMOKE === "true") {
      void runPortalElectronSmoke(window)
        .then(() => app.exit(0))
        .catch((error: unknown) => {
          console.error("Compazio V2 portal smoke failed", error);
          app.exit(1);
        });
    }
    if (process.env.COMPAZIO_V2_PORTAL_INTEGRATION === "true") {
      void runPortalIntegration(window)
        .then(() => app.exit(0))
        .catch((error: unknown) => {
          console.error("Compazio V2 portal integration failed", error);
          app.exit(1);
        });
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    // A second launch reaches the running instance here instead of starting a rival writer.
    app.on("second-instance", () => {
      const existing = BrowserWindow.getAllWindows()[0] ?? createWindow();
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    });
  })
  .catch((error: unknown) => {
    console.error("Compazio V2 failed to start", error);
    app.exit(1);
  });

app.on("window-all-closed", () => app.quit());
/** A stuck subsystem must not keep the window open forever; the last valid file is already on disk. */
const SHUTDOWN_TIMEOUT_MS = 8_000;

function shutdownTrace(stage: string, metadata: Readonly<Record<string, unknown>> = {}): void {
  if (process.env.COMPAZIO_V2_SHUTDOWN_TRACE !== "1") return;
  console.info(
    `COMPAZIO_SHUTDOWN_TRACE ${JSON.stringify({ stage, at: new Date().toISOString(), ...metadata })}`
  );
}

app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  const startedAt = Date.now();
  shutdownTrace("before-quit", { startedAt });
  void Promise.race([
    Promise.allSettled([
      (async () => {
        // Cut off the local MCP boundary first; then close stdin and terminate only the
        // supervisor-owned provider processes.
        await (orchestratorBridge?.shutdown() ?? Promise.resolve());
        shutdownTrace("orchestrator-bridge-complete");
        await (workspaceService?.shutdown() ?? Promise.resolve());
        shutdownTrace("workspace-service-complete");
      })(),
      fileSystemService?.shutdown() ?? Promise.resolve(),
      portalRuntimeManager?.shutdown() ?? Promise.resolve(),
      updateService?.shutdown()
    ]).then((results) => {
      for (const result of results)
        if (result.status === "rejected")
          console.error("Compazio V2 falhou ao encerrar um subsistema", result.reason);
      return "complete" as const;
    }),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS))
  ])
    .then((outcome) => {
      if (outcome === "timeout")
        console.error("Compazio V2 encerrou por timeout de shutdown", {
          timeoutMs: SHUTDOWN_TIMEOUT_MS
        });
    })
    .finally(() => {
      shutdownTrace("electron-quit", { durationMs: Date.now() - startedAt });
      console.info("Compazio V2 encerrado", { durationMs: Date.now() - startedAt });
      releaseTerminalEvents?.();
      releaseOperationalEvents?.();
      app.quit();
    });
});
