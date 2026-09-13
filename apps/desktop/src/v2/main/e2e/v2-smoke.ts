import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

/**
 * Exercised only by `pnpm smoke:v2`. Two Electron launches cross the real renderer → preload → IPC
 * boundary: the first persists a terminal layout, the second restores it and proves deletion sticks.
 */
export async function runV2ElectronSmoke(window: BrowserWindow): Promise<void> {
  const phase = requiredPhase();
  const workingDirectory = requiredEnvironment("COMPAZIO_V2_SMOKE_WORKSPACE");
  const nodeExecutable = requiredEnvironment("COMPAZIO_V2_SMOKE_NODE");
  const fakeAgentPath = requiredEnvironment("COMPAZIO_V2_SMOKE_FAKE_AGENT");
  const fakeMcpCommand = requiredEnvironment("COMPAZIO_V2_SMOKE_FAKE_MCP_COMMAND");
  const realAgent = process.env.COMPAZIO_V2_REAL_AGENT ?? "codex";
  const realAgentModel = process.env.COMPAZIO_V2_REAL_AGENT_MODEL;
  const realTuiRenderOnly = process.env.COMPAZIO_V2_REAL_TUI_RENDER_ONLY === "true";
  const realTuiResizeStress = process.env.COMPAZIO_V2_REAL_TUI_RESIZE_STRESS === "true";
  const realTuiDomRenderer = process.env.COMPAZIO_V2_SMOKE_DOM_TERMINAL === "true";
  if (phase === "ux" || phase === "terminal") {
    window.webContents.on("console-message", (_event, _level, message) => {
      if (message.startsWith("COMPAZIO_UX:")) console.info(message);
    });
  }
  await waitForRenderer(window);
  await runUiSmokeProbe(window);
  await captureUiFrame(window, phase, "ready");
  const scenario = window.webContents.executeJavaScript(
    `(${rendererScenario.toString()})(${JSON.stringify({
      phase,
      workingDirectory,
      nodeExecutable,
      fakeAgentPath,
      fakeMcpCommand,
      realAgent,
      realAgentModel,
      realTuiRenderOnly,
      realTuiResizeStress,
      realTuiDomRenderer
    })})`,
    true
  );
  if (phase === "real-tui" && realTuiRenderOnly) {
    window.show();
    window.focus();
    await waitForRendererFlag(window, "__compazioRealTuiRenderReady", 24_000);
    const bounds = (await window.webContents.executeJavaScript(
      `window.__compazioRealTuiBounds`,
      true
    )) as {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    const captureBounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height))
    };
    let colourfulPixels = 0;
    // A provider can emit its initial control stream before Chromium presents the first painted
    // WebGL frame. Poll the actual terminal pixels, not PTY output or a fixed startup sleep.
    for (let attempt = 0; attempt < 40 && colourfulPixels <= 200; attempt += 1) {
      const capture = await window.webContents.capturePage(captureBounds);
      colourfulPixels = 0;
      const pixels = capture.toBitmap();
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const blue = pixels[offset];
        const green = pixels[offset + 1];
        const red = pixels[offset + 2];
        if (Math.max(red, green, blue) - Math.min(red, green, blue) > 35) colourfulPixels += 1;
      }
      if (colourfulPixels <= 200) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    await captureUiFrame(window, phase, "before-scroll");
    if (realTuiResizeStress) await runRealTuiResizeStress(window, phase);
    await window.webContents.executeJavaScript(
      `window.__compazioRealTuiColourfulPixels = ${colourfulPixels}; window.__compazioRealTuiRenderCaptured = true`,
      true
    );
    const renderResult: unknown = await scenario;
    await captureUiFrame(window, phase, "result");
    if (
      typeof renderResult !== "object" ||
      renderResult === null ||
      !("renderOnly" in renderResult) ||
      renderResult.renderOnly !== true ||
      !("colourfulPixels" in renderResult) ||
      typeof renderResult.colourfulPixels !== "number" ||
      renderResult.colourfulPixels <= 200
    )
      throw new Error(`V2 real-TUI render smoke assertion failed: ${JSON.stringify(renderResult)}`);
    console.info(`V2 real-TUI render acceptance: ${JSON.stringify(renderResult)}`);
    return;
  }
  if (phase === "terminal") {
    await waitForRendererFlag(window, "__compazioPromptInputReady");
    const prompt = (await window.webContents.executeJavaScript(
      `window.__compazioPromptInputCoordinates`,
      true
    )) as { readonly x: number; readonly y: number };
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x: prompt.x,
      y: prompt.y,
      button: "left",
      clickCount: 1
    });
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: prompt.x,
      y: prompt.y,
      button: "left",
      clickCount: 1
    });
    await window.webContents.executeJavaScript(`window.__compazioPromptClickSent = true`, true);
    await waitForRendererFlag(window, "__compazioPromptClickObserved");
    window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "a",
      modifiers: ["control"]
    });
    window.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: "a",
      modifiers: ["control"]
    });
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Delete" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Delete" });
    window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "v",
      modifiers: ["control"]
    });
    window.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: "v",
      modifiers: ["control"]
    });
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await window.webContents.executeJavaScript(`window.__compazioPromptInputSent = true`, true);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await captureUiFrame(window, phase, "prompt");
    await waitForRendererFlag(window, "__compazioTerminalMouseReady");
    const mouse = (await window.webContents.executeJavaScript(
      `window.__compazioTerminalMouseCoordinates`,
      true
    )) as { readonly startX: number; readonly startY: number; readonly endX: number };
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x: mouse.startX,
      y: mouse.startY,
      button: "left",
      clickCount: 1
    });
    window.webContents.sendInputEvent({
      type: "mouseMove",
      x: mouse.endX,
      y: mouse.startY,
      button: "left",
      movementX: mouse.endX - mouse.startX,
      movementY: 0
    });
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: mouse.endX,
      y: mouse.startY,
      button: "left",
      clickCount: 1
    });
    await window.webContents.executeJavaScript(`window.__compazioTerminalMouseSent = true`, true);
    await waitForRendererFlag(window, "__compazioTerminalSigintReady");
    window.webContents.focus();
    const sendKey = (keyCode: string): void => {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    };
    for (const key of "abcdef") sendKey(key);
    for (let index = 0; index < 6; index += 1) sendKey("Backspace");
    for (const key of "abcdef") sendKey(key);
    for (const key of ["Home", "End", "Left", "Right", "Backspace", "Delete"]) sendKey(key);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "c", modifiers: ["control"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "c", modifiers: ["control"] });
    await waitForRendererFlag(window, "__compazioTerminalWheelReady");
    const wheel = (await window.webContents.executeJavaScript(
      `window.__compazioTerminalWheelCoordinates`,
      true
    )) as { readonly x: number; readonly y: number };
    window.webContents.sendInputEvent({
      type: "mouseMove",
      x: wheel.x,
      y: wheel.y,
      movementX: 0,
      movementY: 0
    });
    window.webContents.sendInputEvent({
      type: "mouseWheel",
      x: wheel.x,
      y: wheel.y,
      deltaX: 0,
      // Electron's native input API uses positive wheel ticks for scrolling upward; Chromium
      // converts this into the negative DOM delta consumed by the terminal wheel handler.
      deltaY: 480,
      canScroll: true
    });
    await window.webContents.executeJavaScript(`window.__compazioTerminalWheelSent = true`, true);
    await waitForRendererFlag(window, "__compazioScaledTuiWheelReady");
    const scaledWheel = (await window.webContents.executeJavaScript(
      `window.__compazioScaledTuiWheelCoordinates`,
      true
    )) as { readonly x: number; readonly y: number };
    window.webContents.sendInputEvent({
      type: "mouseMove",
      x: scaledWheel.x,
      y: scaledWheel.y,
      movementX: 0,
      movementY: 0
    });
    window.webContents.sendInputEvent({
      type: "mouseWheel",
      x: scaledWheel.x,
      y: scaledWheel.y,
      deltaX: 0,
      // The fixture is at the bottom of its local history before entering the TUI. Scroll down so
      // the wheel is delivered to the child rather than intentionally reopening local scrollback.
      deltaY: -480,
      canScroll: true
    });
    await window.webContents.executeJavaScript(`window.__compazioScaledTuiWheelSent = true`, true);
  }
  if (phase === "real-tui") {
    window.show();
    window.focus();
    window.webContents.focus();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    await Promise.race([
      waitForRendererFlag(window, "__compazioRealTuiPromptReady", 4_800),
      scenario.then(() => {
        throw new Error("real TUI scenario finished before its prompt probe");
      })
    ]);
    const prompt = (await window.webContents.executeJavaScript(
      `window.__compazioRealTuiPromptCoordinates`,
      true
    )) as { readonly x: number; readonly y: number };
    window.webContents.sendInputEvent({
      type: "mouseMove",
      x: prompt.x,
      y: prompt.y,
      movementX: 0,
      movementY: 0
    });
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x: prompt.x,
      y: prompt.y,
      button: "left",
      clickCount: 1
    });
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: prompt.x,
      y: prompt.y,
      button: "left",
      clickCount: 1
    });
    let focusedPrompt = false;
    for (let attempt = 0; attempt < 20 && !focusedPrompt; attempt += 1) {
      focusedPrompt = (await window.webContents.executeJavaScript(
        `document.activeElement instanceof HTMLTextAreaElement && document.activeElement.getAttribute("aria-label") === "Editar prompt"`,
        true
      )) as boolean;
      if (!focusedPrompt) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (focusedPrompt !== true)
      throw new Error("real TUI prompt did not receive native mouse focus");
    window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "v",
      modifiers: ["control"]
    });
    window.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: "v",
      modifiers: ["control"]
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    const pastedLength = await window.webContents.executeJavaScript(
      `document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.value.length : 0`,
      true
    );
    if (typeof pastedLength !== "number" || pastedLength < 100)
      throw new Error(`real TUI prompt native paste failed: ${String(pastedLength)}`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await window.webContents.executeJavaScript(`window.__compazioRealTuiPromptSent = true`, true);
    await Promise.race([
      waitForRendererFlag(window, "__compazioRealTuiWheelReady", 12_000),
      scenario.then(() => {
        throw new Error("real TUI scenario finished before its wheel probe");
      })
    ]);
    const bounds = (await window.webContents.executeJavaScript(
      `window.__compazioRealTuiBounds`,
      true
    )) as {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    const wheel = (await window.webContents.executeJavaScript(
      `window.__compazioRealTuiWheelCoordinates`,
      true
    )) as { readonly x: number; readonly y: number };
    const captureBounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height))
    };
    const before = await window.webContents.capturePage(captureBounds);
    await captureUiFrame(window, phase, "before-scroll");
    window.webContents.sendInputEvent({
      type: "mouseMove",
      x: wheel.x,
      y: wheel.y,
      movementX: 0,
      movementY: 0
    });
    for (let index = 0; index < 5; index += 1) {
      window.webContents.sendInputEvent({
        type: "mouseWheel",
        x: wheel.x,
        y: wheel.y,
        deltaX: 0,
        deltaY: 480,
        canScroll: true
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 90));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    const after = await window.webContents.capturePage(captureBounds);
    const beforePixels = before.toBitmap();
    const afterPixels = after.toBitmap();
    let changedPixels = 0;
    let colourfulPixels = 0;
    for (let offset = 0; offset < Math.min(beforePixels.length, afterPixels.length); offset += 4) {
      const blue = beforePixels[offset];
      const green = beforePixels[offset + 1];
      const red = beforePixels[offset + 2];
      if (Math.max(red, green, blue) - Math.min(red, green, blue) > 35) colourfulPixels += 1;
      if (
        Math.abs(beforePixels[offset] - afterPixels[offset]) > 20 ||
        Math.abs(beforePixels[offset + 1] - afterPixels[offset + 1]) > 20 ||
        Math.abs(beforePixels[offset + 2] - afterPixels[offset + 2]) > 20
      )
        changedPixels += 1;
    }
    await captureUiFrame(window, phase, "after-scroll");
    await window.webContents.executeJavaScript(
      `window.__compazioRealTuiChangedPixels = ${changedPixels}; window.__compazioRealTuiColourfulPixels = ${colourfulPixels}; window.__compazioRealTuiWheelSent = true`,
      true
    );
  }
  const result: unknown = await scenario;
  await captureUiFrame(window, phase, "result");
  if (phase === "create") {
    if (
      !isCreatedResult(result) ||
      !result.output.includes("SMOKE_ORCHESTRATED") ||
      result.agentCount !== 3 ||
      result.roleCount !== 3 ||
      result.taskCount !== 3 ||
      result.activityCount < 4 ||
      !result.completed ||
      !result.nonOverlapping ||
      result.position.x !== 333
    ) {
      throw new Error(`V2 Electron create smoke assertion failed: ${JSON.stringify(result)}`);
    }
    return;
  }
  if (phase === "license-free") {
    if (
      !isFreeLicenseResult(result) ||
      !result.workspaceDialogOpened ||
      !result.firstCreated ||
      !result.secondCreated ||
      result.licenseDialogOpened ||
      result.workspaceCount !== 2
    ) {
      throw new Error(
        `V2 Electron free-license acceptance assertion failed: ${JSON.stringify(result)}`
      );
    }
    return;
  }
  if (phase === "license-cycle") {
    if (!isLicenseCycleResult(result))
      throw new Error(`V2 Electron license-cycle assertion failed: ${JSON.stringify(result)}`);
    return;
  }
  if (phase === "multi-select") {
    if (!isMultiSelectResult(result))
      throw new Error(`V2 multi-select acceptance assertion failed: ${JSON.stringify(result)}`);
    return;
  }
  if (phase === "ux" && (!isUxResult(result) || !Object.values(result).every(Boolean))) {
    throw new Error(`V2 UX acceptance assertion failed: ${JSON.stringify(result)}`);
  }
  if (phase === "terminal") {
    if (!isTerminalResult(result) || !Object.values(result).every(Boolean))
      throw new Error(`V2 terminal acceptance assertion failed: ${JSON.stringify(result)}`);
    window.minimize();
    await waitForWindowState(window, () => window.isMinimized(), "minimize");
    window.restore();
    window.show();
    await waitForWindowState(window, () => !window.isMinimized() && window.isVisible(), "restore");
    let restored = false;
    for (let attempt = 0; attempt < 40 && !restored; attempt += 1) {
      restored =
        (await window.webContents.executeJavaScript(
          `[...document.querySelectorAll('.v2-terminal-body')].some((terminal) => terminal.querySelector('.v2-xterm .xterm-helper-textarea') !== null && terminal.querySelector('[aria-label="Parar terminal"]') !== null)`,
          true
        )) === true;
      if (!restored) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (restored !== true) throw new Error("V2 terminal did not survive minimize/restore");
    console.info(`V2 terminal acceptance: ${JSON.stringify({ ...result, minimizeRestore: true })}`);
    return;
  }
  if (phase === "recovery-write") {
    if (!isRecoveryWriteResult(result))
      throw new Error(`V2 recovery write assertion failed: ${JSON.stringify(result)}`);
    // The outer runner force-kills this Electron process only after every mutation above has
    // resolved through renderer → preload → IPC → persistence. Keeping it alive makes this a real
    // abrupt-process recovery test rather than a graceful shutdown test.
    process.stdout.write("COMPAZIO_V2_RECOVERY_READY\n");
    await new Promise<void>(() => undefined);
  }
  if (phase === "single-instance-hold") {
    process.stdout.write("COMPAZIO_V2_SINGLE_INSTANCE_READY\n");
    await new Promise<void>(() => undefined);
  }
  if (phase === "recovery-verify") {
    if (!isRecoveryVerifyResult(result))
      throw new Error(`V2 recovery verify assertion failed: ${JSON.stringify(result)}`);
    return;
  }
  if (phase === "atomic-recovery-verify") {
    if (!isAtomicRecoveryVerifyResult(result))
      throw new Error(`V2 atomic recovery verify assertion failed: ${JSON.stringify(result)}`);
    return;
  }
  if (phase === "team-recovery-write") {
    if (!isTeamRecoveryWriteResult(result))
      throw new Error(`V2 TeamRun recovery write assertion failed: ${JSON.stringify(result)}`);
    process.stdout.write("COMPAZIO_V2_TEAM_RECOVERY_READY\n");
    await new Promise<void>(() => undefined);
  }
  if (phase === "team-recovery-verify") {
    if (!isTeamRecoveryVerifyResult(result))
      throw new Error(`V2 TeamRun recovery verify assertion failed: ${JSON.stringify(result)}`);
    return;
  }
  if (
    (phase === "compazio" || phase === "compazio-codex") &&
    (!isCompazioResult(result) ||
      !result.legacyCliBlocked ||
      !result.compazioEnabled ||
      !result.recruited ||
      !result.connectionCreated ||
      !result.roleCreated ||
      !result.taskCompleted ||
      !result.resultReturned ||
      !result.messagesDelivered ||
      !result.dismissed ||
      !result.workerResourcesReleased)
  ) {
    throw new Error(`V2 Compazio Electron smoke assertion failed: ${JSON.stringify(result)}`);
  }
  if (
    phase === "compazio-mixed" &&
    (!isMixedCompazioResult(result) ||
      !result.teamRunCompleted ||
      !result.dependenciesReleased ||
      !result.workerContextDelivered ||
      !result.reviewReturned ||
      !result.clarificationRouted ||
      !result.groupCreated ||
      !result.dismissed ||
      !result.workerResourcesReleased)
  ) {
    throw new Error(`V2 mixed Compazio Electron smoke assertion failed: ${JSON.stringify(result)}`);
  }
  if (
    phase === "compazio-reload" &&
    (!isCompazioReloadedResult(result) || !result.historyPreserved || result.nodesRemaining !== 0)
  ) {
    throw new Error(`V2 Compazio reload smoke assertion failed: ${JSON.stringify(result)}`);
  }
  if (
    phase === "compazio" ||
    phase === "compazio-codex" ||
    phase === "compazio-mixed" ||
    phase === "compazio-reload"
  )
    return;
  if (
    phase === "real" &&
    (!isRealAgentResult(result) ||
      !result.noteCreated ||
      !result.childCreated ||
      !result.connected ||
      !result.childWroteNote ||
      !result.responseReturned ||
      result.nodesRemaining !== 0)
  ) {
    throw new Error(`V2 real-agent smoke assertion failed: ${JSON.stringify(result)}`);
  }
  if (phase === "real-tui") {
    if (
      typeof result !== "object" ||
      result === null ||
      !("provider" in result) ||
      !("wheelEvents" in result) ||
      !("scrollMoved" in result) ||
      !("changedPixels" in result) ||
      typeof result.provider !== "string" ||
      typeof result.wheelEvents !== "number" ||
      result.wheelEvents < 1 ||
      result.scrollMoved !== true ||
      typeof result.changedPixels !== "number" ||
      result.changedPixels <= 2_000
    )
      throw new Error(`V2 real-TUI smoke assertion failed: ${JSON.stringify(result)}`);
    console.info(`V2 real-TUI acceptance: ${JSON.stringify(result)}`);
    return;
  }
  if (phase === "performance") {
    if (
      !isPerformanceResult(result) ||
      result.terminalCount !== 10 ||
      result.noteCount !== 20 ||
      result.edgeCount !== 30 ||
      result.mutationDurationMs > 15_000
    ) {
      throw new Error(`V2 performance fixture assertion failed: ${JSON.stringify(result)}`);
    }
    console.info(`V2 performance fixture: ${JSON.stringify(result)}`);
    return;
  }
  if (
    phase === "files" &&
    (!isFilesResult(result) ||
      !result.treeCreated ||
      !result.saved ||
      !result.diffIncludesChange ||
      !result.contextDelivered ||
      !result.previewMissing ||
      result.nodesRemaining !== 0 ||
      !result.clean)
  ) {
    throw new Error(`V2 files smoke assertion failed: ${JSON.stringify(result)}`);
  }
  if (phase === "files") return;
  if (
    phase === "reload" &&
    (!isReloadedResult(result) ||
      result.position.x !== 333 ||
      result.nodesRemaining !== 0 ||
      !result.inspector ||
      !result.teamSummary ||
      !result.timeline ||
      result.policyId !== "high-performance" ||
      result.terminalCount !== 10 ||
      result.noteCount !== 20 ||
      result.edgeCount !== 30 ||
      result.frameDurationMs > 2_500)
  ) {
    throw new Error(`V2 Electron reload smoke assertion failed: ${JSON.stringify(result)}`);
  }
  if (phase === "reload" && isReloadedResult(result)) {
    console.info(
      `V2 renderer frame sample: ${JSON.stringify({
        terminalCount: result.terminalCount,
        noteCount: result.noteCount,
        edgeCount: result.edgeCount,
        frameDurationMs: result.frameDurationMs
      })}`
    );
  }
  if (
    phase === "cleanup" &&
    (!isCleanupResult(result) || result.nodesRemaining !== 0 || result.runsRemaining !== 0)
  )
    throw new Error(`V2 Electron cleanup smoke assertion failed: ${JSON.stringify(result)}`);
}

async function captureUiFrame(
  window: BrowserWindow,
  phase: string,
  moment: "ready" | "onboarding" | "prompt" | "before-scroll" | "after-scroll" | "result"
): Promise<void> {
  const directory = process.env.COMPAZIO_V2_UI_CAPTURE_DIR;
  if (directory === undefined || directory.length === 0) return;
  await mkdir(directory, { recursive: true });
  const image = await window.webContents.capturePage();
  await writeFile(join(directory, `${phase}-${moment}.png`), image.toPNG());
}

async function runRealTuiResizeStress(window: BrowserWindow, phase: string): Promise<void> {
  const steps = [
    { windowWidth: 1_100, windowHeight: 700, cardWidth: 560, cardHeight: 420 },
    { windowWidth: 1_260, windowHeight: 780, cardWidth: 820, cardHeight: 560 },
    { windowWidth: 1_080, windowHeight: 700, cardWidth: 620, cardHeight: 440 },
    { windowWidth: 1_280, windowHeight: 800, cardWidth: 900, cardHeight: 600 },
    { windowWidth: 1_120, windowHeight: 720, cardWidth: 660, cardHeight: 460 }
  ];
  const positioned = await window.webContents.executeJavaScript(
    `(async () => {
      const screen = document.querySelector('.v2-xterm-screen');
      const card = screen?.closest('[data-node-id]');
      const workspaceList = await window.compazioV2.workspace.list();
      const workspaceId = workspaceList.lastOpenedWorkspaceId;
      const nodeId = card?.dataset.nodeId;
      if (!(card instanceof HTMLElement) || !workspaceId || !nodeId) return false;
      await window.compazioV2.nodes.move({
        workspaceId,
        nodeId,
        position: { x: 40, y: 100 }
      });
      card.style.left = '40px';
      card.style.top = '100px';
      return true;
    })()`,
    true
  );
  if (positioned !== true) throw new Error("real TUI resize stress could not position terminal");
  const results: unknown[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const commitCountBefore = (await window.webContents.executeJavaScript(
      `Number(document.querySelector('.v2-xterm-screen')?.dataset.terminalResizeCommits || 0)`,
      true
    )) as number;
    const outputCharsBefore = (await window.webContents.executeJavaScript(
      `Number(document.querySelector('.v2-xterm-screen')?.dataset.terminalOutputChars || 0)`,
      true
    )) as number;
    window.setSize(step.windowWidth, step.windowHeight, false);
    const resized = await window.webContents.executeJavaScript(
      `(async () => {
        const screen = document.querySelector('.v2-xterm-screen');
        const card = screen?.closest('[data-node-id]');
        if (!(screen instanceof HTMLElement) || !(card instanceof HTMLElement)) return false;
        const workspaceList = await window.compazioV2.workspace.list();
        const workspaceId = workspaceList.lastOpenedWorkspaceId;
        const nodeId = card.dataset.nodeId;
        if (!workspaceId || !nodeId) return false;
        await window.compazioV2.nodes.resize({
          workspaceId,
          nodeId,
          size: { width: ${step.cardWidth}, height: ${step.cardHeight} }
        });
        card.style.width = ${JSON.stringify(`${step.cardWidth}px`)};
        card.style.height = ${JSON.stringify(`${step.cardHeight}px`)};
        window.dispatchEvent(new Event('resize'));
        return true;
      })()`,
      true
    );
    if (resized !== true) throw new Error("real TUI resize stress terminal surface missing");

    let transitionHidden = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const transition = (await window.webContents.executeJavaScript(
        `(() => {
          const screen = document.querySelector('.v2-xterm-screen');
          if (!(screen instanceof HTMLElement)) return undefined;
          const rect = screen.getBoundingClientRect();
          return {
            active: screen.dataset.terminalResizeTransition === 'true',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        })()`,
        true
      )) as
        | {
            readonly active: boolean;
            readonly rect: { x: number; y: number; width: number; height: number };
          }
        | undefined;
      if (transition?.active === true) {
        await window.webContents.executeJavaScript(
          `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
          true
        );
        const bounds = {
          x: Math.max(0, Math.round(transition.rect.x)),
          y: Math.max(0, Math.round(transition.rect.y)),
          width: Math.max(1, Math.round(transition.rect.width)),
          height: Math.max(1, Math.round(transition.rect.height))
        };
        const transitionFrame = await window.webContents.capturePage();
        const transitionCapture = transitionFrame.crop(bounds);
        const transitionPixels = transitionCapture.toBitmap();
        let brightPixels = 0;
        for (let offset = 0; offset < transitionPixels.length; offset += 4) {
          if (
            transitionPixels[offset] > 230 &&
            transitionPixels[offset + 1] > 230 &&
            transitionPixels[offset + 2] > 230
          )
            brightPixels += 1;
        }
        transitionHidden = brightPixels / Math.max(1, transitionPixels.length / 4) < 0.08;
        const directory = process.env.COMPAZIO_V2_UI_CAPTURE_DIR;
        if (directory !== undefined && directory.length > 0) {
          await mkdir(directory, { recursive: true });
          await writeFile(
            join(directory, `${phase}-resize-${index + 1}-transition.png`),
            transitionCapture.toPNG()
          );
        }
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (!transitionHidden)
      throw new Error(`real TUI resize exposed an incomplete frame: ${JSON.stringify(step)}`);

    let state:
      | {
          readonly cols: number;
          readonly rows: number;
          readonly ptyCols: number;
          readonly ptyRows: number;
          readonly transitioning: boolean;
          readonly renderer?: string;
          readonly bufferedChars: number;
          readonly commitCount: number;
          readonly outputChars: number;
          readonly outputCharsSinceResize: number;
          readonly rect: { x: number; y: number; width: number; height: number };
          readonly innerRect?: { x: number; y: number; width: number; height: number };
          readonly canvases: readonly {
            width: number;
            height: number;
            rect: { x: number; y: number; width: number; height: number };
          }[];
        }
      | undefined;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      state = (await window.webContents.executeJavaScript(
        `(() => {
          const screen = document.querySelector('.v2-xterm-screen');
          if (!(screen instanceof HTMLElement)) return undefined;
          const rect = screen.getBoundingClientRect();
          const inner = screen.querySelector('.xterm-screen');
          const innerRect = inner?.getBoundingClientRect();
          return {
            cols: Number(screen.dataset.terminalCols || 0),
            rows: Number(screen.dataset.terminalRows || 0),
            ptyCols: Number(screen.dataset.terminalPtyCols || 0),
            ptyRows: Number(screen.dataset.terminalPtyRows || 0),
            transitioning: screen.dataset.terminalResizeTransition === 'true',
            renderer: screen.dataset.terminalRenderer,
            bufferedChars: Number(screen.dataset.terminalResizeBufferedChars || 0),
            commitCount: Number(screen.dataset.terminalResizeCommits || 0),
            outputChars: Number(screen.dataset.terminalOutputChars || 0),
            outputCharsSinceResize:
              Number(screen.dataset.terminalOutputChars || 0) - ${outputCharsBefore},
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            innerRect: innerRect
              ? { x: innerRect.x, y: innerRect.y, width: innerRect.width, height: innerRect.height }
              : undefined,
            canvases: [...screen.querySelectorAll('canvas')].map((canvas) => {
              const canvasRect = canvas.getBoundingClientRect();
              return {
                width: canvas.width,
                height: canvas.height,
                rect: {
                  x: canvasRect.x,
                  y: canvasRect.y,
                  width: canvasRect.width,
                  height: canvasRect.height
                }
              };
            })
          };
        })()`,
        true
      )) as typeof state;
      if (
        state !== undefined &&
        !state.transitioning &&
        state.commitCount > commitCountBefore &&
        state.cols > 0 &&
        state.rows > 0 &&
        state.cols === state.ptyCols &&
        state.rows === state.ptyRows
      )
        break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (
      state === undefined ||
      state.transitioning ||
      state.commitCount <= commitCountBefore ||
      state.cols < 1 ||
      state.rows < 1 ||
      state.cols !== state.ptyCols ||
      state.rows !== state.ptyRows ||
      state.renderer !== "webgl"
    )
      throw new Error(`real TUI resize geometry diverged: ${JSON.stringify({ step, state })}`);

    // ConPTY/OpenCode can emit an immediate differential frame followed by a synchronized full
    // repaint. Capture only after the byte stream has been quiet for 300 ms; otherwise a test can
    // freeze the exact transient fragment that a human would never consider the settled result.
    let previousOutputChars = -1;
    let stableOutputSamples = 0;
    let finalOutputChars = state.outputChars;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      finalOutputChars = (await window.webContents.executeJavaScript(
        `Number(document.querySelector('.v2-xterm-screen')?.dataset.terminalOutputChars || 0)`,
        true
      )) as number;
      if (finalOutputChars === previousOutputChars) stableOutputSamples += 1;
      else stableOutputSamples = 0;
      previousOutputChars = finalOutputChars;
      if (stableOutputSamples >= 12 && finalOutputChars > outputCharsBefore) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    state = {
      ...state,
      outputChars: finalOutputChars,
      outputCharsSinceResize: finalOutputChars - outputCharsBefore
    };
    if (state.outputCharsSinceResize <= 0)
      throw new Error(`real TUI did not redraw after resize: ${JSON.stringify({ step, state })}`);
    await window.webContents.executeJavaScript(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
      true
    );

    const captureBounds = {
      x: Math.max(0, Math.round(state.rect.x)),
      y: Math.max(0, Math.round(state.rect.y)),
      width: Math.max(
        1,
        Math.round(Math.min(window.getContentBounds().width, state.rect.x + state.rect.width)) -
          Math.max(0, Math.round(state.rect.x))
      ),
      height: Math.max(
        1,
        Math.round(Math.min(window.getContentBounds().height, state.rect.y + state.rect.height)) -
          Math.max(0, Math.round(state.rect.y))
      )
    };
    let colourfulPixels = 0;
    let brightPixels = 0;
    let pixelCount = 1;
    let capture = (await window.webContents.capturePage()).crop(captureBounds);
    // Geometry acknowledgement precedes Chromium's WebGL presentation by a frame or two. Poll the
    // pixels as the user would see them; a persistent blank or giant-white surface still fails.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        capture = (await window.webContents.capturePage()).crop(captureBounds);
      }
      colourfulPixels = 0;
      brightPixels = 0;
      const pixels = capture.toBitmap();
      pixelCount = Math.max(1, pixels.length / 4);
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const blue = pixels[offset];
        const green = pixels[offset + 1];
        const red = pixels[offset + 2];
        if (Math.max(red, green, blue) - Math.min(red, green, blue) > 35) colourfulPixels += 1;
        if (red > 230 && green > 230 && blue > 230) brightPixels += 1;
      }
      if (colourfulPixels > 100 && brightPixels / pixelCount < 0.35) break;
    }
    const brightRatio = brightPixels / pixelCount;
    const directory = process.env.COMPAZIO_V2_UI_CAPTURE_DIR;
    if (directory !== undefined && directory.length > 0) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${phase}-resize-${index + 1}.png`), capture.toPNG());
      const fullFrame = await window.webContents.capturePage();
      await writeFile(join(directory, `${phase}-resize-${index + 1}-full.png`), fullFrame.toPNG());
    }
    if (colourfulPixels <= 100 || brightRatio >= 0.35)
      throw new Error(
        `real TUI resize produced suspicious pixels: ${JSON.stringify({
          step,
          state,
          colourfulPixels,
          brightRatio
        })}`
      );
    results.push({ step, state, transitionHidden, colourfulPixels, brightRatio });
    // Let the card's own persistence observer adopt this exact size before the next mutation.
    await new Promise<void>((resolve) => setTimeout(resolve, 320));
  }
  await window.webContents.executeJavaScript(
    `window.__compazioRealTuiResizeStressResult = ${JSON.stringify(results)}`,
    true
  );
}

async function runUiSmokeProbe(window: BrowserWindow): Promise<void> {
  if (process.env.COMPAZIO_V2_UI_SMOKE !== "true") return;
  const clicked = await window.webContents.executeJavaScript(
    `(() => { const button = document.querySelector('[data-testid="v2-create-workspace"]'); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`,
    true
  );
  if (clicked !== true) throw new Error("V2 UI smoke could not open workspace creation");
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  const open = await window.webContents.executeJavaScript(
    `document.querySelector('.v2-workspace-dialog[role="dialog"]') !== null`,
    true
  );
  await captureUiFrame(window, "onboarding", "onboarding");
  await window.webContents.executeJavaScript(
    `document.querySelector('.v2-workspace-dialog [aria-label="Fechar"]')?.click()`,
    true
  );
  if (open !== true) throw new Error("V2 UI smoke workspace dialog did not open");
}

function rendererScenario(input: {
  readonly phase:
    | "create"
    | "compazio"
    | "compazio-codex"
    | "compazio-mixed"
    | "compazio-reload"
    | "performance"
    | "ux"
    | "terminal"
    | "reload"
    | "cleanup"
    | "files"
    | "real"
    | "real-tui"
    | "license-free"
    | "license-cycle"
    | "recovery-write"
    | "recovery-verify"
    | "atomic-recovery-write"
    | "atomic-recovery-verify"
    | "team-recovery-write"
    | "team-recovery-verify"
    | "single-instance-hold";
  readonly workingDirectory: string;
  readonly nodeExecutable: string;
  readonly fakeAgentPath: string;
  readonly fakeMcpCommand: string;
  readonly realAgent: string;
  readonly realAgentModel?: string;
  readonly realTuiRenderOnly: boolean;
  readonly realTuiResizeStress: boolean;
  readonly realTuiDomRenderer: boolean;
}) {
  const waitForOutput = (
    workspaceId: string,
    nodeId: string,
    marker = "SMOKE_ORCHESTRATED"
  ): Promise<string> =>
    new Promise((resolve, reject) => {
      let text = "";
      const timeout = window.setTimeout(() => {
        unsubscribe();
        reject(new Error(`timed out waiting for terminal output: ${text.slice(-4_000)}`));
      }, 10_000);
      const unsubscribe = window.compazioV2.terminal.onEvent((event) => {
        if (event.type !== "terminal.output") return;
        text += event.data;
        if (text.includes(marker)) {
          window.clearTimeout(timeout);
          unsubscribe();
          resolve(text);
        }
      });
      void (async () => {
        await window.compazioV2.terminal.start({ workspaceId, nodeId });
      })().catch((error: unknown) => {
        window.clearTimeout(timeout);
        unsubscribe();
        reject(error);
      });
    });

  return (async () => {
    if (input.phase === "single-instance-hold") return {};
    if (input.phase === "license-free") {
      const createButton = document.querySelector('[data-testid="v2-create-workspace"]');
      if (!(createButton instanceof HTMLButtonElement))
        throw new Error("workspace create button missing");
      const pause = (milliseconds: number) =>
        new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
      const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (predicate()) return;
          await pause(25);
        }
        throw new Error(`timed out waiting for ${label}`);
      };
      const createThroughDialog = async (name: string): Promise<void> => {
        createButton.click();
        await waitFor(
          () => document.querySelector('.v2-workspace-dialog[role="dialog"]') !== null,
          "workspace dialog"
        );
        const dialog = document.querySelector(".v2-workspace-dialog");
        const nameInput = dialog?.querySelector('input[placeholder="Ex.: Landing page"]');
        const chooseDirectory = [...(dialog?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent?.trim() === "Escolher pasta"
        );
        const submit = dialog?.querySelector('button[type="submit"]');
        if (
          !(nameInput instanceof HTMLInputElement) ||
          !(chooseDirectory instanceof HTMLButtonElement) ||
          !(submit instanceof HTMLButtonElement)
        )
          throw new Error("workspace dialog controls missing");
        const nativeSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        nativeSetter?.call(nameInput, name);
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        chooseDirectory.click();
        await waitFor(() => !submit.disabled, "workspace dialog directory selection");
        submit.click();
      };
      await createThroughDialog("Workspace gratuito A");
      await waitFor(() => window.compazioV2 !== undefined, "workspace API");
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if ((await window.compazioV2.workspace.list()).workspaces.length === 1) break;
        await pause(25);
      }
      const firstCreated = (await window.compazioV2.workspace.list()).workspaces.length === 1;
      await createThroughDialog("Workspace gratuito B");
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if ((await window.compazioV2.workspace.list()).workspaces.length === 2) break;
        await pause(25);
      }
      const listing = await window.compazioV2.workspace.list();
      return {
        workspaceDialogOpened: true,
        firstCreated,
        secondCreated: listing.workspaces.length === 2,
        licenseDialogOpened: document.querySelector("#v2-license-title") !== null,
        workspaceCount: listing.workspaces.length
      };
    }
    if (input.phase === "license-cycle") {
      const before = await window.compazioV2.license.status();
      const activated = await window.compazioV2.license.activate({
        licenseCode: "CMPZ-TEST-0000-0000-0000-0000"
      });
      const first = await window.compazioV2.workspace.create({
        name: "Licença C",
        workingDirectory: input.workingDirectory
      });
      const second = await window.compazioV2.workspace.create({
        name: "Licença D",
        workingDirectory: input.workingDirectory
      });
      await window.compazioV2.license.deactivate();
      const revoked = await window.compazioV2.license.status();
      let denied = false;
      try {
        await window.compazioV2.workspace.create({
          name: "Licença E",
          workingDirectory: input.workingDirectory
        });
      } catch (error) {
        denied = /FREE_WORKSPACE_LIMIT_REACHED|beta gratuito/i.test(
          error instanceof Error ? error.message : String(error)
        );
      }
      const listing = await window.compazioV2.workspace.list();
      return {
        beforeFree: before.plan === "free" && before.maxWorkspaces === null,
        activated: activated.plan === "free" && activated.maxWorkspaces === null,
        existingPreserved:
          listing.workspaces.some((workspace) => workspace.id === first.id) &&
          listing.workspaces.some((workspace) => workspace.id === second.id),
        revoked: revoked.plan === "free" && revoked.maxWorkspaces === null,
        denied
      };
    }
    if (input.phase === "recovery-write") {
      const workspace = await window.compazioV2.workspace.create({
        name: "Recuperação abrupta",
        workingDirectory: input.workingDirectory
      });
      const withNote = await window.compazioV2.nodes.addNote({
        workspaceId: workspace.id,
        title: "Nota persistida antes do kill",
        content: "- [x] estado confirmado"
      });
      const note = withNote.nodes.find(
        (node) => node.type === "note" && node.title === "Nota persistida antes do kill"
      );
      if (note?.type !== "note") throw new Error("recovery note missing");
      const withTerminal = await window.compazioV2.nodes.addTerminal({
        workspaceId: workspace.id,
        title: "Terminal persistido antes do kill",
        agentConfig: { agentId: "custom" },
        position: { x: 333, y: 222 },
        launchConfig: {
          command: input.nodeExecutable,
          args: ["-e", "setInterval(()=>process.stdout.write('RECOVERY_ACTIVE\\n'), 80)"],
          env: {},
          processMode: "pipe"
        }
      });
      const terminal = withTerminal.nodes.find(
        (node) => node.type === "terminal" && node.title === "Terminal persistido antes do kill"
      );
      if (terminal?.type !== "terminal") throw new Error("recovery terminal missing");
      await waitForOutput(workspace.id, terminal.id, "RECOVERY_ACTIVE");
      await window.compazioV2.edges.add({
        workspaceId: workspace.id,
        sourceNodeId: terminal.id,
        targetNodeId: note.id,
        capabilities: ["read-note", "write-note"]
      });
      const withPortal = await window.compazioV2.nodes.addPortal({
        workspaceId: workspace.id,
        title: "Portal persistido antes do kill",
        url: "data:text/html,<title>Recovery Portal</title><main>ok</main>"
      });
      const portal = withPortal.nodes.find(
        (node) => node.type === "portal" && node.title === "Portal persistido antes do kill"
      );
      if (portal?.type !== "portal") throw new Error("recovery portal missing");
      await window.compazioV2.portals.ensure({ workspaceId: workspace.id, portalId: portal.id });
      const preset = await window.compazioV2.agents.createPreset({
        name: "Preset persistido antes do kill",
        agentId: "custom",
        executable: input.nodeExecutable,
        args: ["-e", "process.exit(0)"],
        env: {},
        processMode: "pipe"
      });
      return {
        workspaceId: workspace.id,
        noteId: note.id,
        terminalId: terminal.id,
        presetId: preset.id
      };
    }
    if (input.phase === "recovery-verify") {
      const listing = await window.compazioV2.workspace.list();
      const workspace = listing.workspaces.find((item) => item.name === "Recuperação abrupta");
      if (workspace === undefined)
        return {
          workspaceRestored: false,
          workspaceRenderedDirectly: false,
          noteRestored: false,
          edgeRestored: false,
          presetRestored: false,
          positionRestored: false
        };
      const workspaceRenderedDirectly =
        document.querySelector(".v2-toolbar-title h1")?.textContent?.trim() === workspace.name &&
        document.querySelector(".v2-empty") === null;
      const restored = await window.compazioV2.workspace.open({ workspaceId: workspace.id });
      const note = restored.nodes.find(
        (node) => node.type === "note" && node.title === "Nota persistida antes do kill"
      );
      const terminal = restored.nodes.find(
        (node) => node.type === "terminal" && node.title === "Terminal persistido antes do kill"
      );
      const presets = await window.compazioV2.agents.listPresets();
      const result = {
        workspaceRestored: true,
        workspaceRenderedDirectly,
        noteRestored: note?.type === "note" && note.content === "- [x] estado confirmado",
        edgeRestored:
          note !== undefined &&
          terminal !== undefined &&
          restored.edges.some(
            (edge) =>
              edge.sourceNodeId === terminal.id &&
              edge.targetNodeId === note.id &&
              edge.capabilities.includes("read-note") &&
              edge.capabilities.includes("write-note")
          ),
        portalRestored: restored.nodes.some(
          (node) => node.type === "portal" && node.title === "Portal persistido antes do kill"
        ),
        presetRestored: presets.some((preset) => preset.name === "Preset persistido antes do kill"),
        positionRestored: terminal?.position.x === 333 && terminal.position.y === 222,
        staleSessionCleared: terminal?.type === "terminal" && terminal.sessionId === undefined
      };
      // This workspace exists only for the crash journey. Remove it after every assertion so it
      // cannot become the "last opened" workspace consumed by the subsequent team smoke phases.
      await window.compazioV2.workspace.delete({ workspaceId: workspace.id });
      return result;
    }
    if (input.phase === "atomic-recovery-write") {
      const workspace = await window.compazioV2.workspace.create({
        name: "RecuperaÃ§Ã£o de replace atÃ´mico",
        workingDirectory: input.workingDirectory
      });
      await window.compazioV2.agents.createPreset({
        name: "Preset antes do replace interrompido",
        agentId: "custom",
        executable: input.nodeExecutable,
        args: ["-e", "process.exit(0)"],
        env: {},
        processMode: "pipe"
      });
      // The second save pauses after the real rename. The outer runner kills Electron there,
      // before this call can return and before atomic-file performs its read-back confirmation.
      await window.compazioV2.agents.createPreset({
        name: "Preset instalado no replace interrompido",
        agentId: "custom",
        executable: input.nodeExecutable,
        args: ["-e", "process.exit(0)"],
        env: {},
        processMode: "pipe"
      });
      return { unexpectedCompletion: workspace.id };
    }
    if (input.phase === "atomic-recovery-verify") {
      const presets = await window.compazioV2.agents.listPresets();
      const listing = await window.compazioV2.workspace.list();
      const workspace = listing.workspaces.find(
        (item) => item.name === "RecuperaÃ§Ã£o de replace atÃ´mico"
      );
      const result = {
        firstPresetRestored: presets.some(
          (preset) => preset.name === "Preset antes do replace interrompido"
        ),
        replacementPresetRestored: presets.some(
          (preset) => preset.name === "Preset instalado no replace interrompido"
        ),
        workspaceRestored: workspace !== undefined
      };
      if (workspace !== undefined)
        await window.compazioV2.workspace.delete({ workspaceId: workspace.id });
      return result;
    }
    if (input.phase === "team-recovery-verify") {
      const listing = await window.compazioV2.workspace.list();
      const workspace = listing.workspaces.find(
        (item) => item.name === "RecuperaÃ§Ã£o TeamRun abrupta"
      );
      if (workspace === undefined)
        return {
          workspaceRestored: false,
          runRecovered: false,
          tasksStopped: false,
          recoveryEventRecorded: false
        };
      const state = await window.compazioV2.operations.get({ workspaceId: workspace.id });
      const run = state.teamRuns[0];
      const result = {
        workspaceRestored: true,
        // TeamRun has its own durable lifecycle. "blocked" is the recovery state for a team
        // whose processes cannot be assumed alive after an abrupt close; it is intentionally
        // distinct from the legacy orchestration run's "needs-attention" state.
        runRecovered: run?.status === "blocked",
        tasksStopped:
          state.teamTasks.length === 2 &&
          state.teamTasks.every((task) => ["failed", "blocked", "pending"].includes(task.status)),
        recoveryEventRecorded: state.events.some(
          (event) => event.type === "team.run.blocked" && event.runId === run?.id
        )
      };
      await window.compazioV2.workspace.delete({ workspaceId: workspace.id });
      return result;
    }
    if (
      input.phase === "compazio" ||
      input.phase === "compazio-codex" ||
      input.phase === "compazio-mixed" ||
      input.phase === "team-recovery-write"
    ) {
      const teamRecovery = input.phase === "team-recovery-write";
      const mixedTeam = input.phase === "compazio-mixed" || teamRecovery;
      const codexCompazio = input.phase === "compazio-codex";
      const compazioAgentId = codexCompazio ? "codex" : "claude-code";
      const recruitedAgentId = codexCompazio ? "claude-code" : "codex";
      const expectedRole = codexCompazio ? "Architecture Reviewer" : "Test Engineer";
      const workspace = await window.compazioV2.workspace.create({
        name: teamRecovery ? "RecuperaÃ§Ã£o TeamRun abrupta" : "Compazio MCP Electron smoke",
        workingDirectory: input.workingDirectory
      });
      await window.compazioV2.agents.setExecutablePath({
        agentId: "claude-code",
        executablePath: input.fakeMcpCommand
      });
      await window.compazioV2.agents.setExecutablePath({
        agentId: "codex",
        executablePath: input.fakeMcpCommand
      });
      const legacyProbe = await window.compazioV2.nodes.addTerminal({
        workspaceId: workspace.id,
        title: "Legacy recruit probe",
        orchestrator: true,
        agentConfig: { agentId: "custom" },
        launchConfig: {
          command: input.nodeExecutable,
          args: [
            "-e",
            [
              "const endpoint=process.env.COMPAZIO_BRIDGE_ENDPOINT;",
              "const token=process.env.COMPAZIO_BRIDGE_TOKEN;",
              "fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({args:['recruit','--agent','codex']})})",
              ".then(async response=>{if(response.status!==403)throw new Error('legacy recruit was not denied');process.stdout.write('SMOKE_LEGACY_RECRUIT_BLOCKED')})",
              ".catch(error=>{console.error(error);process.exit(2)});"
            ].join("")
          ],
          env: {},
          processMode: "pipe"
        }
      });
      const legacyTerminal = legacyProbe.nodes.find(
        (node) => node.type === "terminal" && node.title === "Legacy recruit probe"
      );
      if (legacyTerminal?.type !== "terminal") throw new Error("legacy CLI probe terminal missing");
      await waitForOutput(workspace.id, legacyTerminal.id, "SMOKE_LEGACY_RECRUIT_BLOCKED");
      const afterLegacy = await window.compazioV2.workspace.open({ workspaceId: workspace.id });
      const legacyCliBlocked =
        afterLegacy.nodes.filter((node) => node.type === "terminal").length === 1;
      await window.compazioV2.nodes.delete({
        workspaceId: workspace.id,
        nodeId: legacyTerminal.id
      });

      const added = await window.compazioV2.nodes.addTerminal({
        workspaceId: workspace.id,
        title: `${codexCompazio ? "Codex" : "Claude"} Compazio smoke`,
        isCompazio: false,
        agentConfig: { agentId: compazioAgentId },
        launchConfig: {
          command: input.fakeMcpCommand,
          args: [],
          env: {
            COMPAZIO_V2_SMOKE_NODE: input.nodeExecutable,
            COMPAZIO_V2_SMOKE_RECRUIT_AGENT: recruitedAgentId,
            ...(mixedTeam ? { COMPAZIO_V2_SMOKE_MIXED: "true" } : {}),
            ...(input.phase === "compazio-mixed" ? { COMPAZIO_V2_SMOKE_CLARIFICATION: "true" } : {})
          },
          processMode: "pty"
        }
      });
      const compazio = added.nodes.find(
        (node) =>
          node.type === "terminal" &&
          node.title === `${codexCompazio ? "Codex" : "Claude"} Compazio smoke`
      );
      if (compazio?.type !== "terminal") throw new Error("Compazio terminal missing");
      const promoted = await window.compazioV2.nodes.update({
        workspaceId: workspace.id,
        nodeId: compazio.id,
        isCompazio: true
      });
      const promotedCompazio = promoted.nodes.find((node) => node.id === compazio.id);
      const compazioEnabled =
        promotedCompazio?.type === "terminal" && promotedCompazio.isCompazio === true;
      const agentOutput: string[] = [];
      const unsubscribeAgentOutput = window.compazioV2.terminal.onEvent((event) => {
        if (event.type === "terminal.output")
          agentOutput.push(`${event.terminalNodeId}:${event.data}`.slice(-2_000));
      });
      await waitForOutput(
        workspace.id,
        compazio.id,
        mixedTeam ? "SMOKE_MIXED_TEAM_CREATED" : "SMOKE_COMPAZIO_RECRUITED"
      );

      if (teamRecovery) {
        const deadline = Date.now() + 10_000;
        let runState: Awaited<ReturnType<typeof window.compazioV2.operations.get>> | undefined;
        while (Date.now() < deadline) {
          runState = await window.compazioV2.operations.get({ workspaceId: workspace.id });
          const run = runState.teamRuns.find(
            (candidate) => candidate.compazioTerminalId === compazio.id
          );
          const activeTask = runState.teamTasks.some(
            (task) =>
              task.runId === run?.id && ["assigned", "running", "pending"].includes(task.status)
          );
          if (
            run !== undefined &&
            ["planning", "running", "waiting"].includes(run.status) &&
            activeTask
          ) {
            return { workspaceId: workspace.id, runId: run.id, activeTask: true };
          }
          await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        throw new Error(
          `TeamRun did not persist an active checkpoint: ${JSON.stringify({
            state: runState,
            output: agentOutput.join("").slice(-6_000)
          })}`
        );
      }

      let clarificationRouted = false;
      const waitForState = async () => {
        const deadline = Date.now() + 20_000;
        let lastState: Awaited<ReturnType<typeof window.compazioV2.operations.get>> | undefined;
        while (Date.now() < deadline) {
          const state = await window.compazioV2.operations.get({ workspaceId: workspace.id });
          lastState = state;
          const member = state.teamMembers.find(
            (candidate) => candidate.recruitedByTerminalId === compazio.id
          );
          if (mixedTeam) {
            const teamRun = state.teamRuns.find(
              (candidate) => candidate.compazioTerminalId === compazio.id
            );
            const clarification = state.teamUserInputRequests.find(
              (request) =>
                request.runId === teamRun?.id && request.status === "waiting-for-user-input"
            );
            if (clarification !== undefined) {
              await window.compazioV2.teamUserInput.answer({
                workspaceId: workspace.id,
                compazioTerminalId: compazio.id,
                requestId: clarification.id,
                answer: "+55 11 99999-1234"
              });
              clarificationRouted = true;
              await new Promise((resolve) => window.setTimeout(resolve, 100));
              continue;
            }
            const tasks = state.teamTasks.filter((candidate) => candidate.runId === teamRun?.id);
            if (
              member !== undefined &&
              teamRun?.status === "completed" &&
              tasks.length === 2 &&
              tasks.every((candidate) => candidate.status === "completed")
            )
              return { state, member, task: tasks[0], teamRun, tasks };
            await new Promise((resolve) => window.setTimeout(resolve, 100));
            continue;
          }
          const task = state.teamTasks.find(
            (candidate) => candidate.assignedToTerminalId === member?.terminalId
          );
          if (member !== undefined && task?.status === "completed") return { state, member, task };
          await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        throw new Error(
          `fake recruited agent did not persist a structured task result: ${JSON.stringify({
            members: lastState?.teamMembers,
            tasks: lastState?.teamTasks,
            messages: lastState?.messages,
            output: agentOutput.join("").slice(-6_000)
          })}`
        );
      };
      const beforeDismissal = await waitForState();
      const workspaceBeforeDismissal = await window.compazioV2.workspace.open({
        workspaceId: workspace.id
      });
      const activeCompazio = workspaceBeforeDismissal.nodes.find((node) => node.id === compazio.id);
      if (activeCompazio?.type !== "terminal" || activeCompazio.sessionId === undefined)
        throw new Error("Compazio MCP session is not active");
      const dismissedOutput = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          unsubscribe();
          reject(new Error("fake Compazio did not dismiss the recruited agent"));
        }, 10_000);
        const unsubscribe = window.compazioV2.terminal.onEvent((event) => {
          if (event.type !== "terminal.output" || event.terminalNodeId !== compazio.id) return;
          if (
            !event.data.includes(
              mixedTeam ? "SMOKE_MIXED_TEAM_DISMISSED" : "SMOKE_COMPAZIO_DISMISSED"
            )
          )
            return;
          window.clearTimeout(timer);
          unsubscribe();
          resolve();
        });
      });
      if (!mixedTeam) {
        await window.compazioV2.terminal.write({
          workspaceId: workspace.id,
          nodeId: compazio.id,
          sessionId: activeCompazio.sessionId,
          data: `SMOKE_DISMISS:${beforeDismissal.member.id}\\r`
        });
      }
      await dismissedOutput;
      const afterDismissal = await window.compazioV2.operations.get({ workspaceId: workspace.id });
      const restored = await window.compazioV2.workspace.open({ workspaceId: workspace.id });
      unsubscribeAgentOutput();
      const dismissed = mixedTeam
        ? afterDismissal.teamMembers
            .filter((candidate) => candidate.recruitedByTerminalId === compazio.id)
            .every((candidate) => candidate.status === "dismissed")
        : afterDismissal.teamMembers.some(
            (candidate) =>
              candidate.id === beforeDismissal.member.id && candidate.status === "dismissed"
          );
      if (mixedTeam) {
        const mixed = beforeDismissal as typeof beforeDismissal & {
          readonly teamRun?: { readonly status: string };
          readonly tasks?: readonly {
            readonly status: string;
            readonly reviewOf?: string;
            readonly resultRefs: readonly string[];
            readonly result?: { readonly summary: string };
          }[];
        };
        const review = mixed.tasks?.find((task) => task.reviewOf !== undefined);
        return {
          teamRunCompleted: mixed.teamRun?.status === "completed",
          dependenciesReleased:
            review?.status === "completed" && (review.resultRefs?.length ?? 0) > 0,
          workerContextDelivered: beforeDismissal.state.messages.some(
            (message) =>
              message.fromTerminalId !== compazio.id &&
              message.toTerminalId !== compazio.id &&
              message.type === "result"
          ),
          reviewReturned: review?.result?.summary.includes("approved") === true,
          clarificationRouted,
          groupCreated: workspaceBeforeDismissal.groups.some((group) =>
            group.title.includes("API Tasks")
          ),
          dismissed,
          workerResourcesReleased: restored.nodes
            .filter((node) => node.type === "terminal" && node.id !== compazio.id)
            .every((node) => node.sessionId === undefined)
        };
      }
      return {
        legacyCliBlocked,
        compazioEnabled,
        recruited: beforeDismissal.member.agentType === recruitedAgentId,
        connectionCreated: workspaceBeforeDismissal.edges.some(
          (edge) =>
            edge.sourceNodeId === compazio.id &&
            edge.targetNodeId === beforeDismissal.member.terminalId
        ),
        roleCreated: beforeDismissal.member.role.name === expectedRole,
        taskCompleted: beforeDismissal.task.status === "completed",
        resultReturned: beforeDismissal.task.result?.summary === "Fixture validated by fake worker",
        messagesDelivered: afterDismissal.messages.some(
          (message) => message.taskId === beforeDismissal.task.id && message.type === "result"
        ),
        dismissed,
        workerResourcesReleased:
          restored.edges.every(
            (edge) =>
              edge.sourceNodeId !== beforeDismissal.member.terminalId &&
              edge.targetNodeId !== beforeDismissal.member.terminalId
          ) &&
          restored.nodes.every(
            (node) =>
              node.type !== "terminal" ||
              node.id !== beforeDismissal.member.terminalId ||
              node.sessionId === undefined
          )
      };
    }
    if (input.phase === "compazio-reload") {
      const listing = await window.compazioV2.workspace.list();
      const workspaceId = listing.lastOpenedWorkspaceId ?? listing.workspaces[0]?.id;
      if (workspaceId === undefined) throw new Error("Compazio smoke workspace was not restored");
      const workspace = await window.compazioV2.workspace.open({ workspaceId });
      const state = await window.compazioV2.operations.get({ workspaceId });
      const historyPreserved =
        state.teamMembers.some((member) => member.status === "dismissed") &&
        state.teamTasks.some((task) => task.status === "completed" && task.result !== undefined) &&
        state.messages.some((message) => message.type === "result");
      for (const node of workspace.nodes) {
        await window.compazioV2.nodes.delete({ workspaceId, nodeId: node.id });
      }
      const cleaned = await window.compazioV2.workspace.open({ workspaceId });
      return { historyPreserved, nodesRemaining: cleaned.nodes.length };
    }
    if (input.phase === "real") {
      const workspace = await window.compazioV2.workspace.create({
        name: "Teste real temporário",
        workingDirectory: input.workingDirectory
      });
      const prompt = [
        "Use exclusivamente a CLI compazio. Nao leia arquivos de protocolo ou arquivos do workspace.",
        "Se o shell da ferramenta nao reconhecer compazio, use o caminho de fallback da variavel COMPAZIO_BRIDGE_CLI para chamar a mesma CLI privada.",
        "Nao faca perguntas e execute todos os passos agora.",
        "Primeiro execute compazio list.",
        "Depois execute compazio note create Teste-de-Orquestracao INICIO_REAL e guarde o ID da nota retornado.",
        `Execute compazio spawn --agent ${input.realAgent} --title Revisor-Real e guarde o ID do terminal retornado.`,
        "Conecte o terminal Revisor-Real a nota com compazio connect <terminal-id> <nota-id> --capabilities read-note,write-note.",
        "Envie ao Revisor-Real com compazio send --wait --timeout 120 esta tarefa: leia a nota conectada, acrescente FILHO_REAL_OK com compazio note append e responda exatamente FILHO_RESPONDEU_OK usando compazio reply com o request ID recebido.",
        "Somente depois de receber FILHO_RESPONDEU_OK, acrescente ORQUESTRADOR_RECEBEU_OK na mesma nota e execute compazio notify Teste-real-concluido.",
        "Nao execute comandos alternativos, nao crie uma segunda nota, nao feche terminais e nao altere arquivos do workspace."
      ].join(" ");
      const launchArgs =
        input.realAgent === "codex"
          ? ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", prompt]
          : input.realAgent === "claude-code"
            ? [
                "--print",
                "--no-session-persistence",
                "--permission-mode",
                "dontAsk",
                prompt,
                "--allowed-tools",
                "Read,Bash(compazio *)"
              ]
            : input.realAgent === "opencode"
              ? [
                  "run",
                  "--dir",
                  input.workingDirectory,
                  "--dangerously-skip-permissions",
                  ...(input.realAgentModel === undefined ? [] : ["--model", input.realAgentModel]),
                  prompt
                ]
              : (() => {
                  throw new Error(`Unsupported real smoke agent: ${input.realAgent}`);
                })();
      const configured = await window.compazioV2.nodes.addTerminal({
        workspaceId: workspace.id,
        orchestrator: true,
        title: `Orquestrador ${input.realAgent}`,
        agentConfig: { agentId: input.realAgent },
        launchConfig: {
          args: launchArgs,
          env: {},
          processMode: "pty"
        }
      });
      const terminal = configured.nodes.find((node) => node.type === "terminal");
      if (terminal === undefined) throw new Error("real-agent orchestrator was not created");
      let observedOutput = "";
      const unsubscribe = window.compazioV2.terminal.onEvent((event) => {
        if (event.type === "terminal.output" && event.terminalNodeId === terminal.id) {
          observedOutput = `${observedOutput}${event.data}`.slice(-8_000);
        }
      });
      const session = await window.compazioV2.terminal.start({
        workspaceId: workspace.id,
        nodeId: terminal.id
      });
      if (session.state === "failed") throw new Error("real agent failed to start");
      const deadline = Date.now() + 240_000;
      let currentWorkspace = await window.compazioV2.workspace.open({ workspaceId: workspace.id });
      while (Date.now() < deadline) {
        currentWorkspace = await window.compazioV2.workspace.open({ workspaceId: workspace.id });
        const note = currentWorkspace.nodes.find(
          (node) => node.type === "note" && node.title === "Teste-de-Orquestracao"
        );
        if (
          note?.type === "note" &&
          note.content.includes("FILHO_REAL_OK") &&
          note.content.includes("ORQUESTRADOR_RECEBEU_OK")
        )
          break;
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      unsubscribe();
      const note = currentWorkspace.nodes.find(
        (node) => node.type === "note" && node.title === "Teste-de-Orquestracao"
      );
      const child = currentWorkspace.nodes.find(
        (node) =>
          node.type === "terminal" &&
          node.title === "Revisor-Real" &&
          node.orchestratorOwnerNodeId === terminal.id
      );
      const noteCreated = note?.type === "note";
      const childCreated = child?.type === "terminal";
      const connected =
        note?.type === "note" &&
        child?.type === "terminal" &&
        currentWorkspace.edges.some(
          (edge) =>
            edge.sourceNodeId === child.id &&
            edge.targetNodeId === note.id &&
            edge.capabilities.includes("read-note") &&
            edge.capabilities.includes("write-note")
        );
      const childWroteNote = note?.type === "note" && note.content.includes("FILHO_REAL_OK");
      const responseReturned =
        note?.type === "note" && note.content.includes("ORQUESTRADOR_RECEBEU_OK");
      if (!noteCreated || !childCreated || !connected || !childWroteNote || !responseReturned) {
        throw new Error(
          `real agent did not complete the fixture: ${JSON.stringify({
            terminals: currentWorkspace.nodes
              .filter((node) => node.type === "terminal")
              .map((node) => node.title),
            notes: currentWorkspace.nodes
              .filter((node) => node.type === "note")
              .map((node) => ({ title: node.title, content: node.content })),
            edges: currentWorkspace.edges.map((edge) => ({
              sourceNodeId: edge.sourceNodeId,
              targetNodeId: edge.targetNodeId,
              capabilities: edge.capabilities
            })),
            output: observedOutput
          })}`
        );
      }
      for (const node of currentWorkspace.nodes) {
        await window.compazioV2.nodes.delete({ workspaceId: workspace.id, nodeId: node.id });
      }
      const cleaned = await window.compazioV2.workspace.open({ workspaceId: workspace.id });
      return {
        noteCreated,
        childCreated,
        connected,
        childWroteNote,
        responseReturned,
        nodesRemaining: cleaned.nodes.length,
        outputPreview: observedOutput.slice(-1_000)
      };
    }
    if (input.phase === "create") {
      const workspace = await window.compazioV2.workspace.create({
        name: "Electron smoke",
        workingDirectory: input.workingDirectory
      });
      const definitions = await window.compazioV2.agents.listDefinitions();
      if (!definitions.some((definition) => definition.id === "custom")) {
        throw new Error("smoke agent registry does not expose custom command");
      }
      const preset = await window.compazioV2.agents.createPreset({
        name: "Fake operacional",
        agentId: "custom",
        executable: input.nodeExecutable,
        args: [input.fakeAgentPath],
        env: {},
        processMode: "pipe"
      });
      const withNote = await window.compazioV2.nodes.addNote({
        workspaceId: workspace.id,
        title: "Especificação",
        content: "Fixture operacional sem conteúdo sensível."
      });
      const note = withNote.nodes.find((node) => node.type === "note");
      if (note === undefined) throw new Error("smoke note was not created");
      const orchestratorCode = `
(async () => {
  const endpoint = process.env.COMPAZIO_BRIDGE_ENDPOINT;
  const token = process.env.COMPAZIO_BRIDGE_TOKEN;
  const command = async (args) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ args })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(JSON.stringify(payload));
    return payload.result;
  };
  await command(["connect", ${JSON.stringify(note.id)}]);
  const members = [];
  for (const [role, title] of [["developer", "Desenvolvedor"], ["reviewer", "Revisor"], ["tester", "Testador"]]) {
    const recruited = await command(["recruit", "--agent", "custom", "--preset", ${JSON.stringify(preset.id)}, "--role", role, "--title", title]);
    members.push(recruited.terminal.id);
    await command(["connect", recruited.terminal.id, ${JSON.stringify(note.id)}, "--capabilities", "read-note,write-note"]);
  }
  await command(["send", members[0], "SMOKE_TASK_SUCCESS developer", "--wait", "--timeout", "8000"]);
  await command(["send", members[1], "SMOKE_TASK_FAIL reviewer", "--wait", "--timeout", "8000"]);
  await command(["send", members[2], "SMOKE_TASK_SUCCESS tester", "--wait", "--timeout", "8000"]);
  process.stdout.write("SMOKE_ORCHESTRATED:" + JSON.stringify({ members }));
})().catch(error => { console.error(error); process.exit(2); });
`;
      const configured = await window.compazioV2.nodes.addTerminal({
        workspaceId: workspace.id,
        orchestrator: true,
        title: "Orquestrador",
        agentConfig: { agentId: "custom" },
        launchConfig: {
          command: input.nodeExecutable,
          args: ["-e", orchestratorCode],
          env: {},
          processMode: "pipe"
        }
      });
      const terminal = configured.nodes.find((node) => node.type === "terminal");
      if (terminal === undefined) throw new Error("smoke terminal was not created");
      const output = await waitForOutput(workspace.id, terminal.id);
      const waitForState = async (
        predicate: (state: Awaited<ReturnType<typeof window.compazioV2.operations.get>>) => boolean,
        timeoutMs = 10_000
      ) => {
        const deadline = Date.now() + timeoutMs;
        let lastState: Awaited<ReturnType<typeof window.compazioV2.operations.get>> | undefined;
        while (Date.now() < deadline) {
          const state = await window.compazioV2.operations.get({ workspaceId: workspace.id });
          lastState = state;
          if (predicate(state)) return state;
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        throw new Error(`timed out waiting for smoke operations: ${JSON.stringify(lastState)}`);
      };
      let state = await waitForState(
        (candidate) =>
          candidate.assignments.length === 3 &&
          candidate.tasks.length === 3 &&
          candidate.tasks.some((task) => task.status === "failed")
      );
      const failed = state.tasks.find((task) => task.status === "failed");
      if (failed === undefined) throw new Error("controlled failure was not recorded");
      state = await window.compazioV2.tasks.retry({
        workspaceId: workspace.id,
        taskId: failed.id,
        idempotencyKey: `smoke-retry-${failed.id}`
      });
      for (const attention of state.attention.filter((request) => request.status === "open")) {
        state = await window.compazioV2.attention.resolve({
          workspaceId: workspace.id,
          attentionId: attention.id
        });
      }
      const run = state.runs[0];
      if (run === undefined) throw new Error("smoke run was not recorded");
      if (run.status === "needs-attention")
        await window.compazioV2.runs.resume({ workspaceId: workspace.id, runId: run.id });
      state = await waitForState((candidate) =>
        candidate.runs.some((candidateRun) => candidateRun.status === "completed")
      );
      const arrangedWorkspace = await window.compazioV2.workspace.open({
        workspaceId: workspace.id
      });
      const layout = state.teamLayouts[0];
      const layoutNodes =
        layout === undefined
          ? []
          : arrangedWorkspace.nodes.filter((node) => layout.nodeIds.includes(node.id));
      const nonOverlapping = layoutNodes.every((left, leftIndex) =>
        layoutNodes
          .slice(leftIndex + 1)
          .every(
            (right) =>
              left.position.x + left.size.width <= right.position.x ||
              right.position.x + right.size.width <= left.position.x ||
              left.position.y + left.size.height <= right.position.y ||
              right.position.y + right.size.height <= left.position.y
          )
      );
      const moved = await window.compazioV2.nodes.move({
        workspaceId: workspace.id,
        nodeId: terminal.id,
        position: { x: 333, y: 222 }
      });
      return {
        output,
        position: moved.nodes.find((node) => node.id === terminal.id)?.position,
        agentCount: state.assignments.length,
        roleCount: state.assignments.filter((assignment) => assignment.roleId !== undefined).length,
        taskCount: state.tasks.length,
        activityCount: state.activities.length,
        completed: state.runs.some((candidate) => candidate.status === "completed"),
        nonOverlapping,
        layoutNodes: layoutNodes.map((node) => ({
          id: node.id,
          type: node.type,
          position: node.position,
          size: node.size
        }))
      };
    }

    const listing = await window.compazioV2.workspace.list();
    let workspaceId = listing.lastOpenedWorkspaceId ?? listing.workspaces[0]?.id;
    if (input.phase === "multi-select") {
      const pause = (milliseconds: number) =>
        new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
      const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (predicate()) return;
          await pause(25);
        }
        throw new Error(`timed out waiting for ${label}`);
      };
      document.querySelector<HTMLButtonElement>('[data-testid="v2-create-workspace"]')?.click();
      await waitFor(
        () => document.querySelector(".v2-workspace-dialog") !== null,
        "workspace dialog"
      );
      const dialog = document.querySelector<HTMLElement>(".v2-workspace-dialog");
      const name = dialog?.querySelector<HTMLInputElement>(
        'input[placeholder="Ex.: Landing page"]'
      );
      const choose = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Escolher pasta"
      );
      const submit = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (name === null || choose === undefined || submit === null)
        throw new Error("workspace dialog controls missing");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(name, "Multi-select acceptance");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      choose.click();
      await waitFor(() => submit.disabled === false, "workspace directory");
      submit.click();
      await waitFor(
        () => document.querySelector(".v2-workspace-dialog") === null,
        "workspace creation"
      );
      document.querySelector<HTMLButtonElement>('[data-testid="v2-add-note"]')?.click();
      document.querySelector<HTMLButtonElement>('[data-testid="v2-add-note"]')?.click();
      await waitFor(
        () => document.querySelectorAll('[data-testid="v2-node-note"]').length >= 2,
        "two note canvases"
      );
      const noteCards = [...document.querySelectorAll<HTMLElement>('[data-testid="v2-node-note"]')];
      noteCards[0]?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          ctrlKey: true,
          clientX: 100,
          clientY: 100
        })
      );
      await waitFor(
        () => document.querySelectorAll(".v2-node.selected").length === 1,
        "first Ctrl+click selection"
      );
      noteCards[1]?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          ctrlKey: true,
          clientX: 200,
          clientY: 100
        })
      );
      await waitFor(
        () => document.querySelectorAll(".v2-node.selected").length >= 2,
        "multi-selection with Ctrl+click"
      );
      const canvas = document.querySelector<HTMLElement>(".v2-canvas");
      if (canvas === null) throw new Error("canvas surface missing for context menu");
      canvas.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 200
        })
      );
      await waitFor(
        () => document.querySelector(".v2-context-menu") !== null,
        "multi-select context menu"
      );
      const bulkDelete = [
        ...document.querySelectorAll<HTMLButtonElement>(".v2-context-menu button")
      ].find((button) => button.textContent?.trim().startsWith("Excluir ") === true);
      if (bulkDelete === undefined)
        throw new Error("bulk deletion action missing from context menu");
      bulkDelete.click();
      await waitFor(
        () => document.querySelector('[data-testid="v2-confirm-node-delete"]') !== null,
        "in-app bulk deletion confirmation"
      );
      document.querySelector<HTMLButtonElement>('[data-testid="v2-confirm-node-delete"]')?.click();
      await waitFor(
        () => document.querySelectorAll(".v2-node.selected").length === 0,
        "bulk canvas deletion"
      );
      return { ctrlClick: true, contextMenu: true, confirmation: true, deletion: true };
    }
    if (input.phase === "ux" || input.phase === "terminal" || input.phase === "real-tui") {
      const pause = (milliseconds: number) =>
        new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
      const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (predicate()) return;
          await pause(25);
        }
        throw new Error(`timed out waiting for ${label}`);
      };
      document.querySelector<HTMLButtonElement>('[data-testid="v2-create-workspace"]')?.click();
      await waitFor(
        () => document.querySelector(".v2-workspace-dialog") !== null,
        "workspace dialog"
      );
      const dialog = document.querySelector<HTMLElement>(".v2-workspace-dialog");
      const name = dialog?.querySelector<HTMLInputElement>(
        'input[placeholder="Ex.: Landing page"]'
      );
      const choose = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Escolher pasta"
      );
      const submit = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (name === null || choose === undefined || submit === null)
        throw new Error("workspace dialog controls missing");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(
        name,
        input.phase === "terminal"
          ? "Terminal acceptance"
          : input.phase === "real-tui"
            ? `TUI real ${input.realAgent}`
            : "UX acceptance"
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
      choose.click();
      await waitFor(() => submit.disabled === false, "workspace directory");
      submit.click();
      await waitFor(
        () => document.querySelector(".v2-workspace-dialog") === null,
        "workspace creation"
      );
      workspaceId = (await window.compazioV2.workspace.list()).lastOpenedWorkspaceId;
    }
    if (workspaceId === undefined) throw new Error("smoke workspace was not restored");
    const restored = await window.compazioV2.workspace.open({ workspaceId });
    if (input.phase === "cleanup") {
      const cleared =
        restored.nodes.length === 0
          ? restored
          : await window.compazioV2.nodes.deleteMany({
              workspaceId,
              nodeIds: restored.nodes.map((node) => node.id)
            });
      const state = await window.compazioV2.operations.get({ workspaceId });
      return { nodesRemaining: cleared.nodes.length, runsRemaining: state.runs.length };
    }
    if (input.phase === "ux") {
      const trace = (step: string): void => console.info(`COMPAZIO_UX:${step}`);
      const pause = (milliseconds: number) =>
        new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
      const waitFor = async (
        predicate: () => boolean | Promise<boolean>,
        label: string
      ): Promise<void> => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (await predicate()) return;
          await pause(25);
        }
        throw new Error(`timed out waiting for ${label}`);
      };
      const addNote = document.querySelector<HTMLButtonElement>('[data-testid="v2-add-note"]');
      addNote?.click();
      addNote?.click();
      await waitFor(
        () => document.querySelectorAll('[data-testid="v2-node-note"]').length >= 2,
        "note cards"
      );
      trace("notes-created");
      const [firstCard, secondCard] = [
        ...document.querySelectorAll<HTMLElement>('[data-testid="v2-node-note"]')
      ];
      const firstHeader = firstCard?.querySelector<HTMLElement>("header");
      const secondHeader = secondCard?.querySelector<HTMLElement>("header");
      if (
        firstCard === undefined ||
        secondCard === undefined ||
        firstHeader === null ||
        firstHeader === undefined ||
        secondHeader === null ||
        secondHeader === undefined
      )
        throw new Error("UX node headers missing");
      const inspectorHiddenByDefault = document.querySelector(".v2-inspector") === null;
      firstHeader.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      const connectButton = document.querySelector<HTMLButtonElement>(
        '[aria-label="Conectar nós"]'
      );
      await waitFor(() => connectButton?.disabled === false, "connection source selection");
      connectButton?.click();
      await waitFor(
        () => connectButton?.getAttribute("aria-pressed") === "true",
        "connection mode"
      );
      secondHeader.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 100 })
      );
      await waitFor(
        () => document.querySelector(".v2-edges path[role='button']") !== null,
        "connection"
      );
      trace("connection-created");
      // Remove the cable while both endpoint nodes are still individually visible. Grouping can
      // collapse an internal edge by design, which made the old smoke look for a path that no
      // longer existed and accidentally wait on an unrelated context menu.
      const edgeCountBeforeRemove = document.querySelectorAll(
        ".v2-edges path[role='button']"
      ).length;
      const cable = document.querySelector<SVGPathElement>(".v2-edges path[role='button']");
      if (cable === null || edgeCountBeforeRemove === 0)
        throw new Error("connected cable is not visible before grouping");
      cable.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 200 })
      );
      await waitFor(() => document.querySelector(".v2-context-menu") !== null, "edge menu");
      const remove = [
        ...document.querySelectorAll<HTMLButtonElement>(".v2-context-menu button")
      ].find((button) => button.textContent?.trim() === "Desconectar");
      if (remove === undefined) throw new Error("edge removal action is unavailable");
      remove.click();
      await waitFor(
        () =>
          document.querySelectorAll(".v2-edges path[role='button']").length < edgeCountBeforeRemove,
        "edge removal"
      );
      trace("connection-removed");
      firstHeader.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await waitFor(
        () => firstCard.classList.contains("selected"),
        "node selection before inspector"
      );
      const inspectorButton = document.querySelector<HTMLButtonElement>(
        '[aria-label="Mostrar inspector"]'
      );
      inspectorButton?.click();
      await waitFor(() => document.querySelector(".v2-inspector") !== null, "open inspector");
      const inspectorCanOpen = document.querySelector(".v2-inspector") !== null;
      document.querySelector<HTMLButtonElement>('[aria-label="Ocultar inspector"]')?.click();
      await waitFor(() => document.querySelector(".v2-inspector") === null, "close inspector");
      const shortcutButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Atalhos"
      );
      shortcutButton?.click();
      await waitFor(() => document.querySelector(".v2-shortcut-guide") !== null, "shortcut guide");
      document
        .querySelector<HTMLButtonElement>(".v2-shortcut-guide [aria-label='Fechar']")
        ?.click();
      firstCard.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          ctrlKey: true,
          clientX: 100,
          clientY: 100
        })
      );
      secondCard.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          ctrlKey: true,
          clientX: 200,
          clientY: 100
        })
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "a" })
      );
      await waitFor(
        () => document.querySelectorAll(".v2-node.selected").length >= 2,
        "multi selection"
      );
      const groupButton = document.querySelector<HTMLButtonElement>(
        '[aria-label="Agrupar seleção"]'
      );
      if (groupButton?.disabled !== false)
        throw new Error("group button is disabled after selection");
      groupButton.click();
      await waitFor(() => document.querySelector(".v2-canvas-group") !== null, "group creation");
      trace("group-created");
      const notesBeforeAdd = document.querySelectorAll('[data-testid="v2-node-note"]').length;
      document.querySelector<HTMLButtonElement>('[data-testid="v2-add-note"]')?.click();
      await waitFor(
        () =>
          document.querySelectorAll('[data-testid="v2-node-note"]').length === notesBeforeAdd + 1,
        "dock note creation"
      );
      const world = document.querySelector<HTMLElement>(".v2-world");
      const transformBeforeWheel = world?.style.transform;
      firstCard
        .querySelector("textarea")
        ?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 }));
      await pause(40);
      const noteWheelDoesNotZoom = world?.style.transform === transformBeforeWheel;
      trace("returning");
      return {
        logo: document.querySelector('svg.v2-mark[aria-label="Compazio"]') !== null,
        inspectorHiddenByDefault,
        inspectorCanOpen,
        shortcutsOpen: shortcutButton !== undefined,
        multiSelect: true,
        groupWithoutPrompt: true,
        edgeContextDisconnect: true,
        dockButtons: true,
        noteWheelDoesNotZoom
      };
    }
    if (input.phase === "terminal") {
      const pause = (milliseconds: number) =>
        new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
      const waitFor = async (
        predicate: () => boolean | Promise<boolean>,
        label: string,
        attempts = 240
      ): Promise<void> => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (await predicate()) return;
          await pause(25);
        }
        throw new Error(`timed out waiting for terminal ${label}`);
      };
      const terminalFixture = String.raw`
const marker = (value) => process.stdout.write("\r\n" + value + "\r\n");
let received = "";
let keyboardInput = "";
let sigintCount = 0;
let mouseTui = false;
const acknowledgeSigint = () => {
  sigintCount += 1;
  marker("SIGINT_OK_" + sigintCount);
};
process.on("SIGINT", acknowledgeSigint);
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
setTimeout(() => process.stdout.write("\u001b[31mANSI_RED\u001b[0m UNICODE_çã_日本_🚀 BOX_┌─┐│└─┘\r\n\u001b[?2004h"), 400);
process.stdin.on("data", (chunk) => {
  received += chunk;
  keyboardInput += chunk;
  if (received.includes("MOUSE_TUI")) {
    mouseTui = true;
    received = "";
    process.stdout.write("\u001b[?1049h\u001b[2J\u001b[H\u001b[?1003h\u001b[?1006hMOUSE_TUI_READY");
    return;
  }
  if (mouseTui) {
    if (received.includes("LEAVE_TUI")) {
      process.stdout.write("\u001b[?1003l\u001b[?1006l\u001b[?1049l");
      marker("MOUSE_TUI_EXITED");
      mouseTui = false;
      received = "";
      return;
    }
    const mouse = /\u001b\[<6[45];(\d+);(\d+)[Mm]/.exec(received);
    if (mouse) {
      process.stdout.write("\u001b[?1003l\u001b[?1006l\u001b[?1049l");
      marker("MOUSE_TUI_WHEEL_COL_" + mouse[1] + "_ROW_" + mouse[2]);
      mouseTui = false;
      received = "";
    }
    return;
  }
  if (received.includes("FILL_SCROLLBACK")) {
    for (let line = 0; line < 160; line += 1) marker("SCROLLBACK_LINE_" + String(line).padStart(3, "0"));
    received = "";
  }
  if (chunk.includes("\u0003")) acknowledgeSigint();
  if (received.includes("linha α") && received.includes("linha β 🚀")) {
    marker("PASTE_MULTILINE_OK");
    received = "";
  }
  if (received.includes("LARGE_PASTE_BEGIN") && received.includes("LARGE_PASTE_END")) {
    const count = (received.match(/LARGE_PASTE_LINE_/g) || []).length;
    marker(count === 240 ? "PASTE_LARGE_OK" : "PASTE_LARGE_BAD_" + count);
    received = "";
  }
  if (received.includes("CTRL_SHIFT_V_OK")) marker("PASTE_CTRL_SHIFT_V_OK");
  if (received.includes("SHIFT_INSERT_OK")) marker("PASTE_SHIFT_INSERT_OK");
  if (received.includes("PROMPT_NATIVE_EDIT_OK")) {
    marker("PROMPT_NATIVE_EDIT_OK");
    received = "";
  }
  const editingSequence = "abcdef" + "\u007f".repeat(6) + "abcdef\u001b[H\u001b[F\u001b[D\u001b[C\u007f\u001b[3~";
  if (keyboardInput.includes(editingSequence)) {
    marker("KEYBOARD_NATIVE_OK");
    keyboardInput = "";
  }
});
setInterval(() => {}, 1000);
`;
      const existingTerminalIds = new Set(
        restored.nodes.filter((node) => node.type === "terminal").map((node) => node.id)
      );
      let terminalId: string | undefined;
      let observedOutput = "";
      const unsubscribe = window.compazioV2.terminal.onEvent((event) => {
        if (
          event.type === "terminal.output" &&
          (terminalId === undefined || event.terminalNodeId === terminalId)
        )
          observedOutput = `${observedOutput}${event.data}`.slice(-20_000);
      });
      const addTerminal = document.querySelector<HTMLButtonElement>(
        '[data-testid="v2-add-terminal"]'
      );
      if (addTerminal === null) throw new Error("terminal dock action missing");
      addTerminal.click();
      await waitFor(
        () => document.querySelector('form[aria-label="Novo terminal de agente"]') !== null,
        "configuration dialog"
      );
      const terminalForm = document.querySelector<HTMLFormElement>(
        'form[aria-label="Novo terminal de agente"]'
      );
      const agentSelect = terminalForm?.querySelector<HTMLSelectElement>(
        '[data-testid="v2-agent-select"]'
      );
      const details = terminalForm?.querySelector<HTMLDetailsElement>("details");
      if (terminalForm === null || agentSelect === null || details === null)
        throw new Error("terminal configuration controls missing");
      const selectSetter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value"
      )?.set;
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      const textareaSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: true }));
      await pause(0);
      const advancedInputs = [...details.querySelectorAll<HTMLInputElement>("input")];
      const titleInput = advancedInputs[0];
      const executableInput = advancedInputs.at(-1);
      const argumentsInput = details.querySelector<HTMLTextAreaElement>("textarea");
      const transport = details.querySelector<HTMLSelectElement>("select");
      if (
        titleInput === undefined ||
        executableInput === undefined ||
        argumentsInput === null ||
        transport === null
      )
        throw new Error("terminal advanced controls missing");
      const fixtureBytes = new TextEncoder().encode(terminalFixture);
      let fixtureBinary = "";
      for (const byte of fixtureBytes) fixtureBinary += String.fromCharCode(byte);
      const fixtureBase64 = window.btoa(fixtureBinary);
      inputSetter?.call(titleInput, "Terminal acceptance");
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      inputSetter?.call(executableInput, input.nodeExecutable);
      executableInput.dispatchEvent(new Event("input", { bubbles: true }));
      textareaSetter?.call(
        argumentsInput,
        `-e\neval(Buffer.from('${fixtureBase64}','base64').toString('utf8'))`
      );
      argumentsInput.dispatchEvent(new Event("input", { bubbles: true }));
      selectSetter?.call(transport, "pty");
      transport.dispatchEvent(new Event("change", { bubbles: true }));
      await pause(0);
      const createAndStart = terminalForm.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (createAndStart === null) throw new Error("terminal create-and-start action unavailable");
      await waitFor(() => !createAndStart.disabled, "installed agent availability");
      createAndStart.click();
      let terminal: Extract<(typeof restored.nodes)[number], { type: "terminal" }> | undefined;
      await waitFor(async () => {
        const opened = await window.compazioV2.workspace.open({ workspaceId });
        const created = opened.nodes.find(
          (node) => node.type === "terminal" && !existingTerminalIds.has(node.id)
        );
        if (created?.type === "terminal") {
          terminal = created;
          terminalId = created.id;
        }
        return (
          terminal !== undefined &&
          document.querySelector(`[data-node-id="${terminal.id}"]`) !== null
        );
      }, "terminal created through dock");
      if (terminal === undefined) throw new Error("terminal fixture node missing");
      try {
        const cardSelector = `[data-node-id="${terminal.id}"]`;
        await waitFor(
          () => document.querySelector(`${cardSelector} .xterm-helper-textarea`) !== null,
          "xterm surface"
        );
        await waitFor(() => observedOutput.includes("UNICODE_çã_日本_🚀"), "Unicode output");
        const card = document.querySelector<HTMLElement>(cardSelector);
        const screen = card?.querySelector<HTMLElement>(".v2-xterm-screen");
        const textarea = card?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
        if (card === null || card === undefined || screen === null || textarea === null)
          throw new Error("terminal DOM surface missing");
        const promptInput = card.querySelector<HTMLTextAreaElement>(
          '.v2-terminal-prompt textarea[aria-label="Editar prompt"]'
        );
        if (promptInput === null) throw new Error("terminal prompt input missing");
        const promptTraceWindow = window as typeof window & {
          __compazioPromptInputReady?: boolean;
          __compazioPromptInputSent?: boolean;
          __compazioPromptClickSent?: boolean;
          __compazioPromptClickObserved?: boolean;
          __compazioPromptInputCoordinates?: { readonly x: number; readonly y: number };
        };
        const promptSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )?.set;
        promptSetter?.call(promptInput, "APAGAR este prompt inteiro");
        promptInput.dispatchEvent(new Event("input", { bubbles: true }));
        await pause(0);
        promptInput.focus();
        promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
        await window.compazioV2.clipboard.writeText("PROMPT_NATIVE_EDIT_OK");
        const promptRect = promptInput.getBoundingClientRect();
        promptTraceWindow.__compazioPromptInputCoordinates = {
          x: Math.round(promptRect.left + Math.min(82, promptRect.width / 3)),
          y: Math.round(promptRect.top + promptRect.height / 2)
        };
        promptTraceWindow.__compazioPromptInputReady = true;
        await waitFor(
          () => promptTraceWindow.__compazioPromptClickSent === true,
          "native prompt click"
        );
        const clickPosition = promptInput.selectionStart;
        if (clickPosition <= 0 || clickPosition >= promptInput.value.length)
          throw new Error(`prompt click did not position the cursor: ${clickPosition}`);
        promptTraceWindow.__compazioPromptClickObserved = true;
        await waitFor(
          () => promptTraceWindow.__compazioPromptInputSent === true,
          "native prompt keyboard editing"
        );
        await waitFor(
          () => observedOutput.includes("PROMPT_NATIVE_EDIT_OK"),
          "prompt Ctrl+A/Delete/paste/submit"
        );
        if (promptInput.value !== "") throw new Error("submitted prompt input was not cleared");
        const pasteTraceWindow = window as typeof window & {
          __compazioFinalTerminalInputFrames?: {
            readonly length: number;
            readonly bracketed: boolean;
            readonly written: boolean;
          }[];
        };
        pasteTraceWindow.__compazioFinalTerminalInputFrames = [];
        await waitFor(
          () =>
            screen.dataset.terminalRenderer !== undefined &&
            screen.dataset.terminalFontReady !== undefined,
          "renderer diagnostics"
        );
        const ansiRendered =
          screen.dataset.terminalRenderer === "webgl" && observedOutput.includes("ANSI_RED");
        const unicodeRendered = observedOutput.includes("UNICODE_çã_日本_🚀");
        const boxDrawingRendered = observedOutput.includes("BOX_┌─┐│└─┘");

        await window.compazioV2.clipboard.writeText("linha α\nlinha β 🚀");
        textarea.focus();
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            key: "v",
            code: "KeyV"
          })
        );
        for (let attempt = 0; attempt < 240; attempt += 1) {
          if (observedOutput.includes("PASTE_MULTILINE_OK")) break;
          await pause(25);
        }
        if (!observedOutput.includes("PASTE_MULTILINE_OK"))
          throw new Error(`terminal multiline paste missing: ${observedOutput.slice(-4_000)}`);

        const largePaste = [
          "LARGE_PASTE_BEGIN",
          ...Array.from(
            { length: 240 },
            (_, index) => `LARGE_PASTE_LINE_${index.toString().padStart(3, "0")}`
          ),
          "LARGE_PASTE_END"
        ].join("\r\n");
        await window.compazioV2.clipboard.writeText(largePaste);
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            key: "v",
            code: "KeyV"
          })
        );
        await waitFor(
          () => observedOutput.includes("PASTE_LARGE_OK"),
          "complete large bracketed paste"
        );
        const framedLargePasteLength = largePaste.replace(/\r?\n/g, "\r").length + 12;
        if (
          !pasteTraceWindow.__compazioFinalTerminalInputFrames?.some(
            (frame) => frame.written && frame.bracketed && frame.length === framedLargePasteLength
          )
        )
          throw new Error("large clipboard payload was not written as one bracketed-paste frame");

        await window.compazioV2.clipboard.writeText("CTRL_SHIFT_V_OK");
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            shiftKey: true,
            key: "v",
            code: "KeyV"
          })
        );
        await waitFor(() => observedOutput.includes("PASTE_CTRL_SHIFT_V_OK"), "Ctrl+Shift+V paste");
        await window.compazioV2.clipboard.writeText("SHIFT_INSERT_OK");
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            shiftKey: true,
            key: "Insert",
            code: "Insert"
          })
        );
        await waitFor(() => observedOutput.includes("PASTE_SHIFT_INSERT_OK"), "Shift+Insert paste");

        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            shiftKey: true,
            key: "a",
            code: "KeyA"
          })
        );
        await pause(50);

        screen.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 300,
            clientY: 300
          })
        );
        await waitFor(
          () => document.querySelector('.v2-terminal-context-menu[role="menu"]') !== null,
          "context menu"
        );
        const menuCopy = [
          ...document.querySelectorAll<HTMLButtonElement>(".v2-terminal-context-menu button")
        ].find((button) => button.textContent?.trim() === "Copiar");
        const ctrlShiftA = menuCopy !== undefined && !menuCopy.disabled;
        if (!ctrlShiftA) throw new Error("Ctrl+Shift+A did not select the terminal buffer");
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
        await waitFor(
          () => document.querySelector('.v2-terminal-context-menu[role="menu"]') === null,
          "context menu dismissal"
        );
        await pause(50);
        textarea.focus();
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            key: "c",
            code: "KeyC"
          })
        );
        await pause(200);
        const copied = await window.compazioV2.clipboard.readText();
        const ctrlCSelection =
          copied.includes("ANSI_RED") && !observedOutput.includes("SIGINT_OK_");

        screen.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 320,
            clientY: 320
          })
        );
        await waitFor(
          () => document.querySelector('.v2-terminal-context-menu[role="menu"]') !== null,
          "selection context menu"
        );
        const clearSelection = [
          ...document.querySelectorAll<HTMLButtonElement>(".v2-terminal-context-menu button")
        ].find((button) => button.textContent?.trim() === "Limpar seleção");
        if (clearSelection === undefined || clearSelection.disabled)
          throw new Error("terminal clear-selection action unavailable");
        clearSelection.click();

        const screenRect = screen.getBoundingClientRect();
        const mouseTraceWindow = window as typeof window & {
          __compazioTerminalMouseReady?: boolean;
          __compazioTerminalMouseSent?: boolean;
          __compazioTerminalMouseCoordinates?: {
            readonly startX: number;
            readonly startY: number;
            readonly endX: number;
          };
        };
        mouseTraceWindow.__compazioTerminalMouseCoordinates = {
          startX: Math.round(screenRect.left + 20),
          startY: Math.round(screenRect.top + 20),
          endX: Math.round(screenRect.left + 180)
        };
        mouseTraceWindow.__compazioTerminalMouseReady = true;
        await waitFor(
          () => mouseTraceWindow.__compazioTerminalMouseSent === true,
          "native mouse selection"
        );
        await pause(50);
        screen.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 340,
            clientY: 340
          })
        );
        await waitFor(
          () => document.querySelector('.v2-terminal-context-menu[role="menu"]') !== null,
          "mouse-selection context menu"
        );
        const mouseCopy = [
          ...document.querySelectorAll<HTMLButtonElement>(".v2-terminal-context-menu button")
        ].find((button) => button.textContent?.trim() === "Copiar");
        const mouseSelection = mouseCopy !== undefined && !mouseCopy.disabled;
        if (!mouseSelection) throw new Error("mouse drag did not select terminal text");
        const clearMouseSelection = [
          ...document.querySelectorAll<HTMLButtonElement>(".v2-terminal-context-menu button")
        ].find((button) => button.textContent?.trim() === "Limpar seleção");
        clearMouseSelection?.click();
        textarea.focus();
        (
          window as typeof window & { __compazioTerminalSigintReady?: boolean }
        ).__compazioTerminalSigintReady = true;
        await waitFor(
          () =>
            observedOutput.includes("KEYBOARD_NATIVE_OK") && observedOutput.includes("SIGINT_OK_"),
          "native editing keys and Ctrl+C PTY control byte"
        );
        (
          window as typeof window & { __compazioTerminalSigintReady?: boolean }
        ).__compazioTerminalSigintReady = false;

        const initialRows = Number(screen.dataset.terminalRows ?? "0");
        const resizeHandle = card.querySelector<HTMLElement>('[data-testid="v2-node-resize"]');
        if (resizeHandle === null) throw new Error("terminal resize handle missing");
        resizeHandle.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerId: 11,
            button: 0,
            buttons: 1,
            clientX: 700,
            clientY: 500
          })
        );
        resizeHandle.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            cancelable: true,
            pointerId: 11,
            buttons: 1,
            clientX: 960,
            clientY: 720
          })
        );
        resizeHandle.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            pointerId: 11,
            button: 0,
            clientX: 960,
            clientY: 720
          })
        );
        await waitFor(async () => {
          const opened = await window.compazioV2.workspace.open({ workspaceId });
          const node = opened.nodes.find((candidate) => candidate.id === terminal.id);
          return (
            node !== undefined &&
            node.size.width >= terminal.size.width + 200 &&
            node.size.height >= terminal.size.height + 160 &&
            Number(screen.dataset.terminalRows ?? "0") > initialRows
          );
        }, "node and xterm resize");
        const resize = Number(screen.dataset.terminalRows ?? "0") > initialRows;

        const resizeCommitsBeforeStorm = Number(screen.dataset.terminalResizeCommits ?? "0");
        for (let index = 0; index < 100; index += 1) {
          card.style.width = `${720 + (index % 20) * 10}px`;
          card.style.height = `${420 + (index % 15) * 8}px`;
          // Force each geometry to become observable rather than letting the browser collapse the
          // loop into one style assignment. The coordinator may still coalesce PTY commits.
          void card.offsetWidth;
        }
        card.style.width = "920px";
        card.style.height = "600px";
        await waitFor(
          () =>
            Number(screen.dataset.terminalResizeCommits ?? "0") > resizeCommitsBeforeStorm &&
            Number(screen.dataset.terminalCols ?? "0") ===
              Number(screen.dataset.terminalPtyCols ?? "-1") &&
            Number(screen.dataset.terminalRows ?? "0") ===
              Number(screen.dataset.terminalPtyRows ?? "-1") &&
            screen.dataset.terminalResizeTransition !== "true",
          "100-resize terminal storm"
        );
        const resizeStorm100 = true;

        const beforeDrag = (await window.compazioV2.workspace.open({ workspaceId })).nodes.find(
          (candidate) => candidate.id === terminal.id
        )?.position;
        screen.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            button: 0,
            buttons: 1,
            clientX: 360,
            clientY: 340
          })
        );
        screen.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerId: 7,
            buttons: 1,
            clientX: 650,
            clientY: 500
          })
        );
        screen.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            pointerId: 7,
            button: 0,
            clientX: 650,
            clientY: 500
          })
        );
        await pause(100);
        const afterDrag = (await window.compazioV2.workspace.open({ workspaceId })).nodes.find(
          (candidate) => candidate.id === terminal.id
        )?.position;
        const dragIsolation =
          beforeDrag !== undefined && afterDrag?.x === beforeDrag.x && afterDrag.y === beforeDrag.y;

        const world = document.querySelector<HTMLElement>(".v2-world");
        const canvas = document.querySelector<HTMLElement>(".v2-canvas");
        if (world === null || canvas === null) throw new Error("canvas surface missing");
        const transformBeforeTerminalWheel = world.style.transform;
        screen.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 })
        );
        await pause(50);
        const terminalWheelIsolation = world.style.transform === transformBeforeTerminalWheel;
        const activeTerminal = (await window.compazioV2.workspace.open({ workspaceId })).nodes.find(
          (candidate) => candidate.id === terminal.id && candidate.type === "terminal"
        );
        if (activeTerminal?.type !== "terminal" || activeTerminal.sessionId === undefined)
          throw new Error("active terminal session missing for scrollback test");
        await window.compazioV2.terminal.write({
          workspaceId,
          nodeId: terminal.id,
          sessionId: activeTerminal.sessionId,
          data: "FILL_SCROLLBACK"
        });
        await waitFor(
          () => observedOutput.includes("SCROLLBACK_LINE_159"),
          "scrollback fixture output"
        );
        const scrollLineBeforeWheel = Number(screen.dataset.terminalScrollLine);
        if (!Number.isFinite(scrollLineBeforeWheel) || scrollLineBeforeWheel <= 0)
          throw new Error("terminal virtual scroll position missing");
        const viewportRect = screen.getBoundingClientRect();
        const visibleLeft = Math.max(0, viewportRect.left);
        const visibleRight = Math.min(window.innerWidth, viewportRect.right);
        const visibleTop = Math.max(0, viewportRect.top);
        const visibleBottom = Math.min(window.innerHeight, viewportRect.bottom);
        if (visibleRight <= visibleLeft || visibleBottom <= visibleTop)
          throw new Error("terminal viewport is outside the browser window");
        const wheelX = Math.round((visibleLeft + visibleRight) / 2);
        const wheelY = Math.round((visibleTop + visibleBottom) / 2);
        if (document.elementFromPoint(wheelX, wheelY)?.closest(".v2-xterm-screen") !== screen)
          throw new Error("terminal wheel target is obscured");
        const wheelTraceWindow = window as typeof window & {
          __compazioTerminalWheelReady?: boolean;
          __compazioTerminalWheelSent?: boolean;
          __compazioTerminalWheelCoordinates?: { readonly x: number; readonly y: number };
        };
        wheelTraceWindow.__compazioTerminalWheelCoordinates = {
          x: wheelX,
          y: wheelY
        };
        wheelTraceWindow.__compazioTerminalWheelReady = true;
        await waitFor(
          () => wheelTraceWindow.__compazioTerminalWheelSent === true,
          "native terminal wheel"
        );
        await waitFor(
          () => Number(screen.dataset.terminalWheelEvents ?? "0") >= 2,
          "native terminal wheel delivery"
        );
        await waitFor(
          () => Number(screen.dataset.terminalScrollLine) < scrollLineBeforeWheel,
          "terminal scrollback movement"
        );
        const terminalScrollback =
          Number(screen.dataset.terminalScrollLine) < scrollLineBeforeWheel;
        const historyLine = Number(screen.dataset.terminalScrollLine);
        screen.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100_000 })
        );
        await waitFor(
          () => Number(screen.dataset.terminalScrollLine) > historyLine,
          "terminal live viewport restore"
        );
        const zoomOut = document.querySelector<HTMLButtonElement>('[aria-label="Diminuir zoom"]');
        if (zoomOut === null) throw new Error("zoom-out control missing");
        for (let step = 0; step < 4; step += 1) zoomOut.click();
        await waitFor(() => world.style.transform.includes("scale(0."), "scaled terminal canvas");
        await window.compazioV2.terminal.write({
          workspaceId,
          nodeId: terminal.id,
          sessionId: activeTerminal.sessionId,
          data: "MOUSE_TUI"
        });
        await waitFor(() => observedOutput.includes("MOUSE_TUI_READY"), "mouse-tracking TUI");
        screen.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 0 })
        );
        // ConPTY behavior differs across supported Windows images: some versions consume the
        // TUI's DEC private mouse-mode announcement, while others forward it to xterm. Both are
        // valid. The SGR frame and coordinate assertions below verify the actual end-to-end
        // mouse contract regardless of which path is active.
        const scaledRect = screen.getBoundingClientRect();
        const scaledTuiTraceWindow = window as typeof window & {
          __compazioScaledTuiWheelReady?: boolean;
          __compazioScaledTuiWheelSent?: boolean;
          __compazioScaledTuiWheelCoordinates?: { readonly x: number; readonly y: number };
          __compazioFinalTerminalInputFrames?: {
            readonly data?: string;
            readonly written: boolean;
          }[];
        };
        scaledTuiTraceWindow.__compazioFinalTerminalInputFrames = [];
        const scaledWheelX = Math.round(scaledRect.left + scaledRect.width / 2);
        const scaledWheelY = Math.round(scaledRect.top + scaledRect.height / 2);
        if (
          document.elementFromPoint(scaledWheelX, scaledWheelY)?.closest(".v2-xterm-screen") !==
          screen
        )
          throw new Error("scaled terminal wheel target is obscured");
        scaledTuiTraceWindow.__compazioScaledTuiWheelCoordinates = {
          x: scaledWheelX,
          y: scaledWheelY
        };
        scaledTuiTraceWindow.__compazioScaledTuiWheelReady = true;
        await waitFor(
          () => scaledTuiTraceWindow.__compazioScaledTuiWheelSent === true,
          "scaled TUI native wheel"
        );
        await waitFor(
          () =>
            scaledTuiTraceWindow.__compazioFinalTerminalInputFrames?.some(
              // eslint-disable-next-line no-control-regex -- SGR mouse reports begin with ESC.
              (frame) => frame.written && /^\u001b\[<6[45];\d+;\d+M$/.test(frame.data ?? "")
            ) === true,
          "scaled TUI mouse bridge"
        );
        const scaledMouseFrame = scaledTuiTraceWindow.__compazioFinalTerminalInputFrames?.find(
          // eslint-disable-next-line no-control-regex -- SGR mouse reports begin with ESC.
          (frame) => frame.written && /^\u001b\[<6[45];\d+;\d+M$/.test(frame.data ?? "")
        )?.data;
        const scaledMouseColumn = Number(
          // eslint-disable-next-line no-control-regex -- SGR mouse reports begin with ESC.
          /^\u001b\[<6[45];(\d+);\d+M$/.exec(scaledMouseFrame ?? "")?.[1]
        );
        if (!Number.isFinite(scaledMouseColumn) || scaledMouseColumn < 40)
          throw new Error(`scaled terminal mouse column was not remapped: ${scaledMouseColumn}`);
        // On Windows, ConPTY converts this VT input into a MOUSE_EVENT_RECORD. The Node fixture
        // intentionally reads raw stdin bytes and therefore cannot observe that Win32 record;
        // reaching a completed IPC write here is the terminal frontend's end-to-end boundary.
        const scaledTuiMouse = true;
        await window.compazioV2.terminal.write({
          workspaceId,
          nodeId: terminal.id,
          sessionId: activeTerminal.sessionId,
          data: "LEAVE_TUI"
        });
        await waitFor(() => observedOutput.includes("MOUSE_TUI_EXITED"), "mouse TUI exit");
        canvas.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: -120,
            clientX: window.innerWidth - 30,
            clientY: window.innerHeight - 30
          })
        );
        await waitFor(() => world.style.transform !== transformBeforeTerminalWheel, "canvas zoom");
        return {
          promptNativeEditing: true,
          typing: true,
          backspace: true,
          firstCharacterDeletion: true,
          deleteHomeEnd: true,
          mouseSelection,
          unicode: unicodeRendered,
          boxDrawing: boxDrawingRendered,
          ansi: ansiRendered,
          rendererWebgl: screen.dataset.terminalRenderer === "webgl",
          packagedFont: screen.dataset.terminalFontReady === "true",
          multilinePaste: true,
          pasteCtrlV: true,
          pasteCtrlShiftV: true,
          pasteShiftInsert: true,
          ctrlShiftA,
          ctrlCSelection,
          ctrlCSigint: true,
          resize,
          resizeStorm100,
          dragIsolation,
          terminalWheelIsolation,
          terminalScrollback,
          scaledTuiMouse,
          canvasZoom: true
        };
      } finally {
        unsubscribe();
      }
    }
    if (input.phase === "real-tui") {
      const inputTraceWindow = window as typeof window & {
        __compazioFinalTerminalInputFrames?: {
          readonly length: number;
          readonly bracketed: boolean;
          readonly enter: boolean;
          readonly written: boolean;
          readonly data?: string;
        }[];
      };
      inputTraceWindow.__compazioFinalTerminalInputFrames = [];
      const pause = (milliseconds: number) =>
        new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
      const waitFor = async (
        predicate: () => boolean | Promise<boolean>,
        label: string,
        attempts = 9_600
      ): Promise<void> => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (await predicate()) return;
          await pause(25);
        }
        throw new Error(`timed out waiting for real TUI ${label}`);
      };
      const existingTerminalIds = new Set(
        restored.nodes.filter((node) => node.type === "terminal").map((node) => node.id)
      );
      let terminalId: string | undefined;
      let observedOutput = "";
      const unsubscribe = window.compazioV2.terminal.onEvent((event) => {
        if (
          event.type === "terminal.output" &&
          (terminalId === undefined || event.terminalNodeId === terminalId)
        )
          observedOutput = `${observedOutput}${event.data}`.slice(-100_000);
      });
      try {
        const installations = await window.compazioV2.agents.detectAll();
        const requestedInstallation = installations.find(
          (installation) => installation.agentId === input.realAgent
        );
        if (requestedInstallation?.status !== "installed") {
          throw new Error(
            `real TUI provider preflight failed: ${JSON.stringify(requestedInstallation)}`
          );
        }
        await pause(100);
        const addTerminal = document.querySelector<HTMLButtonElement>(
          '[data-testid="v2-add-terminal"]'
        );
        if (addTerminal === null) throw new Error("real TUI terminal dock action missing");
        addTerminal.click();
        await waitFor(
          () => document.querySelector('form[aria-label="Novo terminal de agente"]') !== null,
          "configuration dialog"
        );
        const terminalForm = document.querySelector<HTMLFormElement>(
          'form[aria-label="Novo terminal de agente"]'
        );
        const agentSelect = terminalForm?.querySelector<HTMLSelectElement>(
          '[data-testid="v2-agent-select"]'
        );
        if (terminalForm === null || agentSelect === null)
          throw new Error("real TUI terminal configuration controls missing");
        agentSelect.value = input.realAgent;
        const requestedOption = [...agentSelect.options].find(
          (option) => option.value === input.realAgent
        );
        if (requestedOption === undefined)
          throw new Error(`real TUI provider option is missing: ${input.realAgent}`);
        agentSelect.selectedIndex = requestedOption.index;
        agentSelect.dispatchEvent(new Event("input", { bubbles: true }));
        agentSelect.dispatchEvent(new Event("change", { bubbles: true }));
        await pause(100);
        const createAndStart =
          terminalForm.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (createAndStart === null)
          throw new Error("real TUI create-and-start action unavailable");
        for (let attempt = 0; attempt < 1_200 && createAndStart.disabled; attempt += 1) {
          await pause(25);
        }
        if (createAndStart.disabled) {
          throw new Error(
            `real TUI provider unavailable: ${JSON.stringify({
              requested: input.realAgent,
              selected: agentSelect.value,
              options: [...agentSelect.options].map((option) => option.value),
              status: terminalForm.querySelector(".v2-agent-status")?.textContent
            })}`
          );
        }
        createAndStart.click();
        let terminal: Extract<(typeof restored.nodes)[number], { type: "terminal" }> | undefined;
        await waitFor(async () => {
          const opened = await window.compazioV2.workspace.open({ workspaceId });
          const created = opened.nodes.find(
            (node) => node.type === "terminal" && !existingTerminalIds.has(node.id)
          );
          if (created?.type === "terminal") {
            terminal = created;
            terminalId = created.id;
          }
          return terminal !== undefined;
        }, "provider terminal creation");
        if (terminal === undefined) throw new Error("real TUI provider terminal missing");
        const cardSelector = `[data-node-id="${terminal.id}"]`;
        await waitFor(
          () => document.querySelector(`${cardSelector} .xterm-helper-textarea`) !== null,
          "xterm surface"
        );
        const card = document.querySelector<HTMLElement>(cardSelector);
        const screen = card?.querySelector<HTMLElement>(".v2-xterm-screen");
        const promptInput = card?.querySelector<HTMLTextAreaElement>(
          '.v2-terminal-prompt textarea[aria-label="Editar prompt"]'
        );
        if (card === null || card === undefined || screen === null || promptInput === null)
          throw new Error("real TUI DOM surface missing");
        await waitFor(
          () =>
            screen.dataset.terminalRenderer !== undefined &&
            screen.dataset.terminalFontReady !== undefined,
          "terminal renderer diagnostics",
          800
        );
        const rendererDiagnostics = {
          renderer: screen.dataset.terminalRenderer,
          fontReady: screen.dataset.terminalFontReady,
          fontFamily: screen.dataset.terminalFontFamily,
          devicePixelRatio: screen.dataset.terminalDevicePixelRatio
        };
        const expectedRenderer = input.realTuiDomRenderer ? "dom-fallback" : "webgl";
        if (
          rendererDiagnostics.renderer !== expectedRenderer ||
          rendererDiagnostics.fontReady !== "true"
        )
          throw new Error(
            `real TUI terminal renderer is not release-safe: ${JSON.stringify(rendererDiagnostics)}`
          );
        if (input.realTuiRenderOnly) {
          await waitFor(() => observedOutput.length > 100, "provider startup output", 2_400);
          await pause(1_500);
          const screenRect = screen.getBoundingClientRect();
          const visibleLeft = Math.max(0, screenRect.left);
          const visibleRight = Math.min(window.innerWidth, screenRect.right);
          const visibleTop = Math.max(0, screenRect.top);
          const visibleBottom = Math.min(window.innerHeight, screenRect.bottom);
          const renderTraceWindow = window as typeof window & {
            __compazioRealTuiRenderReady?: boolean;
            __compazioRealTuiRenderCaptured?: boolean;
            __compazioRealTuiColourfulPixels?: number;
            __compazioRealTuiResizeStressResult?: unknown;
            __compazioRealTuiBounds?: {
              readonly x: number;
              readonly y: number;
              readonly width: number;
              readonly height: number;
            };
          };
          renderTraceWindow.__compazioRealTuiBounds = {
            x: visibleLeft,
            y: visibleTop,
            width: visibleRight - visibleLeft,
            height: visibleBottom - visibleTop
          };
          renderTraceWindow.__compazioRealTuiRenderReady = true;
          await waitFor(
            () => renderTraceWindow.__compazioRealTuiRenderCaptured === true,
            "render capture",
            2_400
          );
          const colourfulPixels = renderTraceWindow.__compazioRealTuiColourfulPixels ?? 0;
          if (colourfulPixels <= 200)
            throw new Error(
              `real TUI terminal is visually monochrome: ${JSON.stringify({
                provider: input.realAgent,
                colourfulPixels,
                rendererDiagnostics
              })}`
            );
          const opened = await window.compazioV2.workspace.open({ workspaceId });
          for (const node of opened.nodes)
            await window.compazioV2.nodes.delete({ workspaceId, nodeId: node.id });
          return {
            provider: input.realAgent,
            renderOnly: true,
            colourfulPixels,
            rendererDiagnostics,
            ...(input.realTuiResizeStress
              ? { resizeStress: renderTraceWindow.__compazioRealTuiResizeStressResult }
              : {})
          };
        }
        await waitFor(() => !promptInput.disabled, "running provider prompt", 2_400);
        if (input.realAgent === "codex" || input.realAgent === "claude-code") {
          const trustPrompt =
            input.realAgent === "codex"
              ? "Do you trust the contents of this directory?"
              : "Quick safety check:";
          for (
            let attempt = 0;
            attempt < 800 && !observedOutput.includes(trustPrompt);
            attempt += 1
          ) {
            await pause(25);
          }
          if (observedOutput.includes(trustPrompt)) {
            const opened = await window.compazioV2.workspace.open({ workspaceId });
            const active = opened.nodes.find(
              (node) => node.type === "terminal" && node.id === terminal?.id
            );
            if (active?.type !== "terminal" || active.sessionId === undefined)
              throw new Error("real TUI trust prompt has no active session");
            await window.compazioV2.terminal.write({
              workspaceId,
              nodeId: active.id,
              sessionId: active.sessionId,
              data: "\r"
            });
          }
        }
        // A live PTY exists slightly before a full-screen provider has mounted its composer. This
        // delay is test-side only: it prevents the automated user from typing into process startup,
        // while production input remains provider-agnostic and sleep-free.
        await pause(5_000);
        await window.compazioV2.clipboard.writeText(
          "Responda sem markdown com exatamente 40 linhas curtas numeradas de LINHA_SCROLL_001 ate LINHA_SCROLL_040. A ultima linha deve ser exatamente FIM_SCROLL_040. Nao use ferramentas."
        );
        const promptRect = promptInput.getBoundingClientRect();
        const promptTraceWindow = window as typeof window & {
          __compazioRealTuiPromptReady?: boolean;
          __compazioRealTuiPromptSent?: boolean;
          __compazioRealTuiPromptCoordinates?: { readonly x: number; readonly y: number };
        };
        promptTraceWindow.__compazioRealTuiPromptCoordinates = {
          x: Math.round(promptRect.left + promptRect.width / 2),
          y: Math.round(promptRect.top + promptRect.height / 2)
        };
        promptTraceWindow.__compazioRealTuiPromptReady = true;
        await waitFor(
          () => promptTraceWindow.__compazioRealTuiPromptSent === true,
          "native prompt submission",
          4_800
        );
        for (
          let attempt = 0;
          attempt < 5_600 && !observedOutput.includes("FIM_SCROLL_040");
          attempt += 1
        ) {
          await pause(25);
        }
        if (!observedOutput.includes("FIM_SCROLL_040")) {
          throw new Error(
            `real TUI provider response timed out: ${JSON.stringify({
              provider: input.realAgent,
              inputFrames: inputTraceWindow.__compazioFinalTerminalInputFrames,
              output: observedOutput.slice(-8_000)
            })}`
          );
        }
        await pause(800);
        const screenRect = screen.getBoundingClientRect();
        const visibleLeft = Math.max(0, screenRect.left);
        const visibleRight = Math.min(window.innerWidth, screenRect.right);
        const visibleTop = Math.max(0, screenRect.top);
        const visibleBottom = Math.min(window.innerHeight, screenRect.bottom);
        if (visibleRight <= visibleLeft || visibleBottom <= visibleTop)
          throw new Error("real TUI viewport is outside the window");
        const traceWindow = window as typeof window & {
          __compazioRealTuiWheelReady?: boolean;
          __compazioRealTuiWheelSent?: boolean;
          __compazioRealTuiChangedPixels?: number;
          __compazioRealTuiColourfulPixels?: number;
          __compazioRealTuiBounds?: {
            readonly x: number;
            readonly y: number;
            readonly width: number;
            readonly height: number;
          };
          __compazioRealTuiWheelCoordinates?: { readonly x: number; readonly y: number };
        };
        const scrollLineBefore = Number(screen.dataset.terminalScrollLine ?? "0");
        const wheelEventsBefore = Number(screen.dataset.terminalWheelEvents ?? "0");
        traceWindow.__compazioRealTuiBounds = {
          x: visibleLeft,
          y: visibleTop,
          width: visibleRight - visibleLeft,
          height: visibleBottom - visibleTop
        };
        traceWindow.__compazioRealTuiWheelCoordinates = {
          x: Math.round((visibleLeft + visibleRight) / 2),
          y: Math.round((visibleTop + visibleBottom) / 2)
        };
        traceWindow.__compazioRealTuiWheelReady = true;
        await waitFor(
          () => traceWindow.__compazioRealTuiWheelSent === true,
          "native wheel",
          24_000
        );
        const wheelEvents = Number(screen.dataset.terminalWheelEvents ?? "0") - wheelEventsBefore;
        const scrollLineAfter = Number(screen.dataset.terminalScrollLine ?? "0");
        const changedPixels = traceWindow.__compazioRealTuiChangedPixels ?? 0;
        const colourfulPixels = traceWindow.__compazioRealTuiColourfulPixels ?? 0;
        const scrollMoved = changedPixels > 2_000;
        if (wheelEvents < 1 || !scrollMoved || changedPixels <= 2_000 || colourfulPixels <= 200) {
          throw new Error(
            `real TUI scroll did not move: ${JSON.stringify({
              provider: input.realAgent,
              wheelEvents,
              scrollLineBefore,
              scrollLineAfter,
              changedPixels,
              colourfulPixels,
              rendererDiagnostics
            })}`
          );
        }
        const opened = await window.compazioV2.workspace.open({ workspaceId });
        for (const node of opened.nodes) {
          await window.compazioV2.nodes.delete({ workspaceId, nodeId: node.id });
        }
        return {
          provider: input.realAgent,
          wheelEvents,
          scrollMoved,
          changedPixels,
          colourfulPixels,
          rendererDiagnostics
        };
      } finally {
        unsubscribe();
      }
    }
    if (input.phase === "performance") {
      const startedAt = performance.now();
      let expanded = restored;
      while (expanded.nodes.filter((node) => node.type === "terminal").length < 10) {
        expanded = await window.compazioV2.nodes.addTerminal({
          workspaceId,
          title: `Terminal de carga ${expanded.nodes.length + 1}`,
          agentConfig: { agentId: "shell" }
        });
      }
      while (expanded.nodes.filter((node) => node.type === "note").length < 20) {
        expanded = await window.compazioV2.nodes.addNote({
          workspaceId,
          title: `Nota de carga ${expanded.nodes.length + 1}`
        });
      }
      const terminals = expanded.nodes.filter((node) => node.type === "terminal");
      const notes = expanded.nodes.filter((node) => node.type === "note");
      let pair = 0;
      while (expanded.edges.length < 30) {
        const source = terminals[pair % terminals.length];
        const target = notes[Math.floor(pair / terminals.length) % notes.length];
        pair += 1;
        if (source === undefined || target === undefined) break;
        if (
          expanded.edges.some(
            (edge) => edge.sourceNodeId === source.id && edge.targetNodeId === target.id
          )
        ) {
          continue;
        }
        expanded = await window.compazioV2.edges.add({
          workspaceId,
          sourceNodeId: source.id,
          targetNodeId: target.id,
          capabilities: []
        });
      }
      return {
        terminalCount: expanded.nodes.filter((node) => node.type === "terminal").length,
        noteCount: expanded.nodes.filter((node) => node.type === "note").length,
        edgeCount: expanded.edges.length,
        mutationDurationMs: performance.now() - startedAt
      };
    }
    if (input.phase === "files") {
      // The Phase 4 controlled retry fixture leaves this marker behind intentionally. It is not a
      // product artifact, so remove it before measuring Git's clean post-commit state.
      await window.compazioV2.files
        .delete({ workspaceId, path: "reviewer-retried" })
        .catch(() => undefined);
      const treeWorkspace = await window.compazioV2.nodes.addFileTree({ workspaceId });
      const tree = treeWorkspace.nodes.find((node) => node.type === "file-tree");
      if (tree === undefined || tree.type !== "file-tree")
        throw new Error("file tree was not created");
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (document.querySelector('[data-testid="v2-node-file-tree"]') !== null) break;
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      const treeCreated = document.querySelector('[data-testid="v2-node-file-tree"]') !== null;
      const created = await window.compazioV2.files.create({
        workspaceId,
        path: "draft.ts",
        content: "export const draft = true;\n"
      });
      await window.compazioV2.files.delete({ workspaceId, path: "draft.ts" });
      const opened = await window.compazioV2.files.read({ workspaceId, path: "example.ts" });
      const saved = await window.compazioV2.files.write({
        workspaceId,
        path: "example.ts",
        content: "export const smoke = 2;\n",
        expectedRevision: opened.revision
      });
      const changed = await window.compazioV2.git.status({ workspaceId });
      const diff = await window.compazioV2.git.diff({ workspaceId, path: "example.ts" });
      const configured = await window.compazioV2.nodes.addTerminal({
        workspaceId,
        title: "Revisor de arquivos",
        agentConfig: { agentId: "custom" },
        launchConfig: {
          command: input.nodeExecutable,
          args: [input.fakeAgentPath],
          env: {},
          processMode: "pipe"
        }
      });
      const terminal = configured.nodes.find(
        (node) => node.type === "terminal" && node.title === "Revisor de arquivos"
      );
      if (terminal === undefined || terminal.type !== "terminal")
        throw new Error("file review terminal was not created");
      const connected = await window.compazioV2.edges.add({
        workspaceId,
        sourceNodeId: tree.id,
        targetNodeId: terminal.id,
        capabilities: ["share-context"]
      });
      const edge = connected.edges.find(
        (candidate) => candidate.sourceNodeId === tree.id && candidate.targetNodeId === terminal.id
      );
      if (edge === undefined) throw new Error("file tree was not connected");
      const contextDelivered = await new Promise<boolean>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          unsubscribe();
          reject(new Error("file context did not reach fake agent"));
        }, 10_000);
        const unsubscribe = window.compazioV2.terminal.onEvent((event) => {
          if (event.type !== "terminal.output" || event.terminalNodeId !== terminal.id) return;
          if (!event.data.includes("SMOKE_FILE_CONTEXT")) return;
          window.clearTimeout(timer);
          unsubscribe();
          resolve(true);
        });
        void (async () => {
          await window.compazioV2.terminal.start({ workspaceId, nodeId: terminal.id });
          await window.compazioV2.files.sendContext({
            workspaceId,
            sourceNodeId: tree.id,
            targetTerminalId: terminal.id,
            context: {
              kind: "diff",
              workspaceId,
              path: "example.ts",
              relativePath: "example.ts",
              revision: saved.revision,
              diff: diff.diff
            }
          });
        })().catch((error: unknown) => {
          window.clearTimeout(timer);
          unsubscribe();
          reject(error);
        });
      });
      const previewWorkspace = await window.compazioV2.nodes.addFilePreview({
        workspaceId,
        filePath: "fixture.png",
        previewKind: "image"
      });
      const preview = previewWorkspace.nodes.find((node) => node.type === "file-preview");
      if (preview === undefined || preview.type !== "file-preview")
        throw new Error("file preview was not created");
      await window.compazioV2.files.delete({ workspaceId, path: "fixture.png" });
      const missing = await window.compazioV2.files.preview({ workspaceId, path: "fixture.png" });
      await window.compazioV2.git.stage({ workspaceId, paths: ["example.ts", "fixture.png"] });
      const afterCommit = await window.compazioV2.git.commit({
        workspaceId,
        message: "smoke file review"
      });
      const current = await window.compazioV2.workspace.open({ workspaceId });
      for (const node of current.nodes) {
        await window.compazioV2.nodes.delete({ workspaceId, nodeId: node.id });
      }
      const afterDeletion = await window.compazioV2.workspace.open({ workspaceId });
      return {
        treeCreated,
        saved: created.content.includes("draft") && saved.content.includes("2"),
        diffIncludesChange:
          changed.files.some((file) => file.path === "example.ts") &&
          diff.diff.includes("+export const smoke = 2"),
        contextDelivered,
        previewMissing: missing.missing,
        clean: afterCommit.files.length === 0,
        remainingFiles: afterCommit.files.map((file) => `${file.status}:${file.path}`),
        nodesRemaining: afterDeletion.nodes.length
      };
    }
    const terminal = restored.nodes.find((node) => node.type === "terminal" && node.orchestrator);
    if (terminal === undefined) throw new Error("smoke terminal was not restored");
    if (terminal.agentConfig.agentId !== "custom" || !terminal.orchestrator) {
      throw new Error("smoke agent configuration was not restored");
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        document.querySelectorAll('[data-testid="v2-node-terminal"]').length === 10 &&
        document.querySelectorAll('[data-testid="v2-node-note"]').length === 20
      ) {
        break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    const frameStartedAt = performance.now();
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const frameDurationMs = performance.now() - frameStartedAt;
    const waitForElement = async (selector: string) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element !== null) return element;
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      throw new Error(`smoke UI element missing: ${selector}`);
    };
    const recruitedNode = await waitForElement(
      '[data-testid="v2-node-terminal"]:not([data-node-id="' + terminal.id + '"])'
    );
    const recruitedHeader = recruitedNode.querySelector<HTMLElement>(".v2-node-header");
    recruitedHeader?.focus();
    recruitedHeader?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const inspectorToggle = document.querySelector<HTMLButtonElement>(
      '[aria-label="Mostrar inspector"]'
    );
    inspectorToggle?.click();
    const inspector = (await waitForElement('[data-testid="v2-inspector"]')) !== null;
    const teamButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Equipe"
    );
    teamButton?.click();
    const teamSummary = (await waitForElement('[data-testid="v2-team-summary"]')) !== null;
    const historyButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Histórico"
    );
    historyButton?.click();
    const timeline = (await waitForElement('[data-testid="v2-timeline"]')) !== null;
    const performanceButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Alta Performance"
    );
    performanceButton?.click();
    let state = await window.compazioV2.operations.get({ workspaceId });
    for (let attempt = 0; attempt < 50 && state.policyId !== "high-performance"; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      state = await window.compazioV2.operations.get({ workspaceId });
    }
    const run = state.runs[0];
    if (run === undefined) throw new Error("restored smoke run is missing");
    await window.compazioV2.runs.deleteTeam({ workspaceId, runId: run.id });
    const teamDeleted = await window.compazioV2.workspace.open({ workspaceId });
    for (const node of teamDeleted.nodes) {
      await window.compazioV2.nodes.delete({ workspaceId, nodeId: node.id });
    }
    const afterDeletion = await window.compazioV2.workspace.open({ workspaceId });
    return {
      position: terminal.position,
      nodesRemaining: afterDeletion.nodes.length,
      inspector,
      teamSummary,
      timeline,
      policyId: state.policyId,
      terminalCount: restored.nodes.filter((node) => node.type === "terminal").length,
      noteCount: restored.nodes.filter((node) => node.type === "note").length,
      edgeCount: restored.edges.length,
      frameDurationMs
    };
  })();
}

/**
 * One-off final-product journey driver. It is deliberately opt-in and uses only normal renderer
 * controls for every mutation: the native directory picker remains a human setup step, then the
 * single mission is sent through Prompt Composer. It never manufactures canvas data or task
 * results. This driver is removed after the acceptance run.
 */
export async function runFinalProductJourney(window: BrowserWindow): Promise<void> {
  const mode = process.env.COMPAZIO_FINAL_PRODUCT_MODE ?? "journey";
  const projectDirectory = requiredFinalEnvironment("COMPAZIO_FINAL_PROJECT_DIRECTORY");
  const artifactsDirectory = requiredFinalEnvironment("COMPAZIO_FINAL_ARTIFACTS_DIRECTORY");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(artifactsDirectory, { recursive: true });
  await waitForRenderer(window);

  if (mode === "verify") {
    const snapshot = await finalSnapshot(window, "Bella Pele — Master E2E");
    if (!finalShape(snapshot, projectDirectory))
      throw new Error(
        `Final journey did not persist a complete workspace: ${JSON.stringify(snapshot)}`
      );
    const portalUrl = snapshot.portalUrls.find((url) =>
      /^http:\/\/(?:127\.0\.0\.1|localhost):418\d\d\/$/.test(url)
    );
    const restoredPortal =
      portalUrl === undefined
        ? null
        : await fetch(portalUrl)
            .then(async (response) => ({ ok: response.ok, html: await response.text() }))
            .catch(() => null);
    if (restoredPortal?.ok !== true || !/Bella Pele/i.test(restoredPortal.html))
      throw new Error("The persisted managed Portal was not functional after restart");
    await arrangeFinalWorkspaceForApproval(window);
    await captureFinalFrame(window, artifactsDirectory, "workflow-reopened.png");
    process.stdout.write(`COMPAZIO_FINAL_PERSISTENCE_PASS ${JSON.stringify(snapshot)}\n`);
    return;
  }
  if (mode !== "journey") throw new Error("COMPAZIO_FINAL_PRODUCT_MODE must be journey or verify");

  process.stdout.write("COMPAZIO_FINAL_JOURNEY_STARTING\n");
  const creation = (await window.webContents.executeJavaScript(
    `(async () => {
      try {
        return { ok: true, value: await (${finalRendererJourney.toString()})(${JSON.stringify({
          projectDirectory,
          workspaceName: "Bella Pele — Master E2E",
          mission: finalProductMission
        })}) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.name + ": " + error.message + "\\n" + (error.stack ?? "") : String(error) };
      }
    })()`,
    true
  )) as
    | {
        readonly ok: true;
        readonly value: {
          readonly workspaceId: string;
          readonly compazioId: string;
          readonly initialCanvasEmpty: boolean;
          readonly inputFrames: readonly {
            readonly length: number;
            readonly bracketed: boolean;
            readonly enter: boolean;
            readonly written: boolean;
          }[];
        };
      }
    | { readonly ok: false; readonly error: string };
  if (!creation.ok) throw new Error(`Final renderer journey failed: ${creation.error}`);
  const created = creation.value;
  if (!created.initialCanvasEmpty)
    throw new Error("Final journey canvas was not empty before Compazio");
  process.stdout.write(`COMPAZIO_FINAL_MISSION_SENT ${JSON.stringify(created)}\n`);
  await captureFinalFrame(window, artifactsDirectory, "workflow-after-single-mission.png");

  // Each real provider request owns a 900-second SLA and QA may legitimately require up to three
  // Builder -> Reviewer cycles. The journey deadline must cover that contract instead of cutting
  // a healthy correction cycle short.
  const deadline = Date.now() + 70 * 60_000;
  let latest: FinalSnapshot | undefined;
  let lastTerminalOutput = "";
  const lastTerminalOutputs = new Map<string, string>();
  let terminalOutputUpdates = 0;
  const handledCodexModelPrompts = new Set<string>();
  while (Date.now() < deadline) {
    latest = await finalSnapshot(window, "Bella Pele — Master E2E");
    if (latest.terminalOutput !== lastTerminalOutput) {
      lastTerminalOutput = latest.terminalOutput;
      terminalOutputUpdates += 1;
      if (terminalOutputUpdates === 1 || terminalOutputUpdates % 30 === 0) {
        const terminalTail = lastTerminalOutput
          .slice(-600)
          .replace(terminalAnsiCsiPattern(), "")
          .replace(/[\r\n]+/g, " ");
        process.stdout.write(
          `COMPAZIO_FINAL_TERMINAL update=${terminalOutputUpdates} length=${lastTerminalOutput.length} tail=${terminalTail}\n`
        );
      }
    }
    for (const [terminalId, output] of Object.entries(latest.terminalOutputs)) {
      if (lastTerminalOutputs.get(terminalId) === output) continue;
      lastTerminalOutputs.set(terminalId, output);
      const terminal = latest.terminals.find((candidate) => candidate.id === terminalId);
      const terminalTail = output
        .slice(-1_200)
        .replace(terminalAnsiCsiPattern(), "")
        .replace(/[\r\n]+/g, " ");
      process.stdout.write(
        `COMPAZIO_FINAL_PROVIDER terminal=${JSON.stringify(terminal?.title ?? terminalId)} agent=${JSON.stringify(terminal?.agentId ?? "unknown")} length=${output.length} tail=${terminalTail}\n`
      );
    }
    const promptedCodex = latest.terminals.find((terminal) => {
      const output = latest?.terminalOutputs[terminal.id] ?? "";
      return (
        terminal.agentId === "codex" &&
        !handledCodexModelPrompts.has(terminal.id) &&
        output.includes("Approaching rate limits") &&
        output.includes("Keep current model")
      );
    });
    if (promptedCodex !== undefined) {
      await chooseEconomicalCodexModelForAcceptance(window, promptedCodex.id);
      handledCodexModelPrompts.add(promptedCodex.id);
      process.stdout.write(
        `COMPAZIO_FINAL_CODEX_MODEL_PROMPT_HANDLED terminal=${JSON.stringify(promptedCodex.title)}\n`
      );
      continue;
    }
    if (finalShape(latest, projectDirectory)) break;
    if (latest.runStatuses.some((status) => ["failed", "cancelled"].includes(status)))
      throw new Error(`Autonomous TeamRun did not complete: ${JSON.stringify(latest)}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  if (latest === undefined || !finalShape(latest, projectDirectory))
    throw new Error(`Final journey timed out: ${JSON.stringify(latest)}`);
  await captureFinalFrame(window, artifactsDirectory, "workflow-completed.png");
  process.stdout.write(`COMPAZIO_FINAL_AUTONOMY_PASS ${JSON.stringify(latest)}\n`);
}

/** Acceptance-only response to Codex's rate-limit suggestion. Accepts its default Luna fallback. */
async function chooseEconomicalCodexModelForAcceptance(
  window: BrowserWindow,
  terminalId: string
): Promise<void> {
  const handled = await window.webContents.executeJavaScript(
    `(async () => {
      const listed = await window.compazioV2.workspace.list();
      const workspaceId = listed.lastOpenedWorkspaceId;
      if (workspaceId === null) return false;
      const workspace = await window.compazioV2.workspace.open({ workspaceId });
      const terminal = workspace.nodes.find((node) => node.type === "terminal" && node.id === ${JSON.stringify(terminalId)});
      if (terminal?.type !== "terminal" || terminal.sessionId === undefined) return false;
      await window.compazioV2.terminal.write({
        workspaceId,
        nodeId: terminal.id,
        sessionId: terminal.sessionId,
        data: "\\r"
      });
      return true;
    })()`,
    true
  );
  if (handled !== true) throw new Error("Codex model suggestion had no active coordinator session");
}

const finalProductMission = `Crie uma landing page premium e responsiva para a clínica Bella Pele, com objetivo de gerar agendamentos pelo WhatsApp +55 11 99999-1234.

Você é o coordenador visível do Compazio. Faça tudo sem pedir que eu pressione Enter e sem usar workers ocultos, TeamRun ou processos de agentes fora do canvas. Use somente os comandos documentados em COMPAZIO_PROTOCOL e as ferramentas MCP locais do Compazio. Se o comando compazio não estiver no PATH de uma shell, invoque o caminho de COMPAZIO_BRIDGE_CLI.

1. Crie pelo MCP uma Nota “Bella Pele — Briefing” com briefing, decisões, checklist, implementação e uma seção “QA Review”. Crie também os Arquivos do projeto no canvas.
2. Grave uma referência visual própria e segura em bella-pele-reference.svg e fixe-a no canvas com file_preview_create.
3. Use compazio spawn para criar e iniciar dois terminais PTY visíveis: OpenCode Builder (agent opencode, papel developer) e Codex Reviewer (agent codex, papel reviewer). Não use Claude. Mantenha ambos abertos.
4. Conecte Nota, Arquivos e Image aos dois agentes com compazio connect. Confirme o contexto com context_list/context_read.
5. Envie ao OpenCode Builder, com compazio send --wait --timeout 900, a implementação real de index.html, styles.css e script.js. Exija header, hero premium, tratamentos, benefícios, prova social, depoimentos, CTA de WhatsApp, FAQ, footer, acessibilidade básica, responsividade sem overflow e resposta final via compazio reply com evidências. Ele não deve iniciar servidor. Para manter a entrega dentro do prazo, exija uma implementação deliberadamente concisa: no máximo 8 KB em index.html, 12 KB em styles.css e 4 KB em script.js, sem SVGs inline extensos nem textos repetitivos. Ele deve criar primeiro os três arquivos completos, validar os limites e só então atualizar a Nota e responder; não deve gastar o prazo em polimento incremental de um único arquivo.
   Guarde o requestId retornado. Se uma espera expirar, use somente compazio wait nesse mesmo requestId; nunca reenvie a tarefa nem crie outra solicitação enquanto ela estiver delivered.
6. Após receber o Builder, crie pelo MCP um Portal com serveWorkspace true; use a porta livre gerenciada pelo Compazio. Conecte diretamente o OpenCode Builder e o Codex Reviewer ao Portal com dois comandos explícitos \`compazio connect <terminal-id> <portal-id>\`. Não conecte apenas o Coordinator nem dependa de contexto herdado. Confirme que os dois edges terminal→Portal concedem portal-read, portal-control e portal-screenshot antes da revisão.
7. Envie ao Codex Reviewer, com compazio send --wait --timeout 900, uma revisão independente no Portal. Exija viewport 1440x900 e 390x844, screenshots, console, overflow, espaçamento, tipografia, CTA, interações e acessibilidade; ele deve registrar achados concretos na seção QA Review da Nota e responder via compazio reply com “QA PASS” ou “QA FAIL”.
   Também aqui, qualquer nova espera deve reutilizar o requestId original com compazio wait; jamais duplique uma revisão em andamento.
8. Se houver QA FAIL, envie a correção ao Builder e repita a revisão, no máximo três ciclos. Finalize apenas com QA PASS, Portal funcional, arquivos reais e Nota atualizada. Depois de receber o QA PASS formal e antes de concluir, acrescente exatamente ao fim da Nota uma seção “## Resultado Final” seguida por uma linha “QA PASS”. Só então use compazio notify para registrar a conclusão. Não escreva essa seção durante um QA FAIL e não feche os terminais.`;

interface FinalSnapshot {
  readonly nodeTypes: readonly string[];
  readonly terminals: readonly {
    readonly id: string;
    readonly title: string;
    readonly agentId: string;
    readonly isCompazio: boolean;
    readonly owner?: string;
  }[];
  readonly noteContents: readonly string[];
  readonly portals: readonly { readonly id: string; readonly url: string }[];
  readonly portalUrls: readonly string[];
  readonly edges: readonly {
    readonly sourceNodeId: string;
    readonly targetNodeId: string;
    readonly capabilities: readonly string[];
  }[];
  readonly edgeCount: number;
  readonly runStatuses: readonly string[];
  readonly teamMembers: readonly {
    readonly agentType: string;
    readonly parentTerminalId: string;
    readonly grantedCapabilities: readonly string[];
  }[];
  readonly taskStatuses: readonly string[];
  readonly taskTitles: readonly string[];
  readonly userInputRequests: readonly {
    readonly id: string;
    readonly compazioTerminalId: string;
    readonly question: string;
    readonly status: string;
    readonly answer?: string;
  }[];
  readonly terminalOutput: string;
  readonly terminalOutputs: Readonly<Record<string, string>>;
}

async function finalSnapshot(window: BrowserWindow, workspaceName: string): Promise<FinalSnapshot> {
  return (await window.webContents.executeJavaScript(
    `(async () => {
      const listed = await window.compazioV2.workspace.list();
      const summary = listed.workspaces.find((candidate) => candidate.name === ${JSON.stringify(workspaceName)});
      if (summary === undefined) return { nodeTypes: [], terminals: [], noteContents: [], portals: [], portalUrls: [], edges: [], edgeCount: 0, runStatuses: [], teamMembers: [], taskStatuses: [], taskTitles: [], userInputRequests: [], terminalOutput: "", terminalOutputs: {} };
      const workspace = await window.compazioV2.workspace.open({ workspaceId: summary.id });
      const state = await window.compazioV2.operations.get({ workspaceId: summary.id });
      return {
        nodeTypes: workspace.nodes.map((node) => node.type),
        terminals: workspace.nodes.filter((node) => node.type === "terminal").map((node) => ({ id: node.id, title: node.title, agentId: node.agentConfig.agentId, isCompazio: node.isCompazio === true, ...(node.orchestratorOwnerNodeId === undefined ? {} : { owner: node.orchestratorOwnerNodeId }) })),
        noteContents: workspace.nodes.filter((node) => node.type === "note").map((node) => node.content),
        portals: workspace.nodes.filter((node) => node.type === "portal").map((node) => ({ id: node.id, url: node.url })),
        portalUrls: workspace.nodes.filter((node) => node.type === "portal").map((node) => node.url),
        edges: workspace.edges.map((edge) => ({ sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, capabilities: edge.capabilities })),
        edgeCount: workspace.edges.length,
        runStatuses: state.teamRuns.map((run) => run.status),
        teamMembers: state.teamMembers.map((member) => ({ agentType: member.agentType, parentTerminalId: member.parentTerminalId, grantedCapabilities: member.grantedCapabilities })),
        taskStatuses: state.teamTasks.map((task) => task.status),
        taskTitles: state.teamTasks.map((task) => task.title),
        userInputRequests: state.teamUserInputRequests.map((request) => ({ id: request.id, compazioTerminalId: request.compazioTerminalId, question: request.question, status: request.status, ...(request.answer === undefined ? {} : { answer: request.answer }) })),
        terminalOutput: String(window.__compazioFinalTerminalOutput ?? ""),
        terminalOutputs: Object.fromEntries(
          Object.entries(window.__compazioFinalTerminalOutputs ?? {}).map(([terminalId, output]) => [terminalId, String(output)])
        )
      };
    })()`,
    true
  )) as FinalSnapshot;
}

function finalShape(snapshot: FinalSnapshot, projectDirectory: string): boolean {
  const compazio = snapshot.terminals.find(
    (terminal) => terminal.isCompazio && terminal.agentId === "codex"
  );
  const builder = snapshot.terminals.find(
    (terminal) => terminal.agentId === "opencode" && /OpenCode Builder/i.test(terminal.title)
  );
  const reviewer = snapshot.terminals.find(
    (terminal) => terminal.agentId === "codex" && /Codex Reviewer/i.test(terminal.title)
  );
  const hierarchy =
    compazio !== undefined &&
    builder !== undefined &&
    reviewer !== undefined &&
    builder.owner === compazio.id &&
    reviewer.owner === compazio.id;
  const portal = snapshot.portals.find((candidate) =>
    /^http:\/\/(?:127\.0\.0\.1|localhost):418\d\d\//.test(candidate.url)
  );
  const hasPortalAccess = (terminalId: string | undefined) =>
    terminalId !== undefined &&
    portal !== undefined &&
    snapshot.edges.some(
      (edge) =>
        edge.sourceNodeId === terminalId &&
        edge.targetNodeId === portal.id &&
        ["portal-read", "portal-control", "portal-screenshot"].every((capability) =>
          edge.capabilities.includes(capability)
        )
    );
  const filesExist = ["index.html", "styles.css", "script.js", "bella-pele-reference.svg"].every(
    (file) => existsSync(join(projectDirectory, file))
  );
  return (
    hierarchy &&
    hasPortalAccess(builder?.id) &&
    hasPortalAccess(reviewer?.id) &&
    filesExist &&
    ["note", "file-tree", "file-preview", "portal"].every((type) =>
      snapshot.nodeTypes.includes(type)
    ) &&
    snapshot.edgeCount >= 10 &&
    snapshot.portalUrls.some((url) => /^http:\/\/(?:127\.0\.0\.1|localhost):418\d\d\//.test(url)) &&
    snapshot.noteContents.some(
      (content) =>
        /Bella Pele/i.test(content) &&
        /QA Review/i.test(content) &&
        /## Resultado Final\s+QA PASS\s*$/i.test(content)
    )
  );
}

async function arrangeFinalWorkspaceForApproval(window: BrowserWindow): Promise<void> {
  const arranged = await window.webContents.executeJavaScript(
    `(async () => {
      const pause = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
      const listed = await window.compazioV2.workspace.list();
      const workspaceId = listed.lastOpenedWorkspaceId;
      if (workspaceId === null) return false;
      const workspace = await window.compazioV2.workspace.open({ workspaceId });
      const by = (predicate) => workspace.nodes.find(predicate)?.id;
      const compazio = by((node) => node.type === "terminal" && node.isCompazio === true);
      const builder = by((node) => node.type === "terminal" && /OpenCode Builder/i.test(node.title));
      const reviewer = by((node) => node.type === "terminal" && /Codex Reviewer/i.test(node.title));
      const note = by((node) => node.type === "note");
      const files = by((node) => node.type === "file-tree");
      const reference = by((node) => node.type === "file-preview");
      const portal = by((node) => node.type === "portal");
      if ([compazio, builder, reviewer, note, files, reference, portal].some((id) => id === undefined)) return false;
      const positions = {
        [compazio]: { x: 440, y: 320 },
        [builder]: { x: 1200, y: 320 },
        [reviewer]: { x: 1960, y: 320 },
        [note]: { x: 560, y: 20 },
        [files]: { x: -80, y: 240 },
        [reference]: { x: 1310, y: -100 },
        [portal]: { x: 1120, y: 800 }
      };
      await window.compazioV2.nodes.moveMany({ workspaceId, positions });
      document.querySelector('.v2-workspace-row.active .v2-workspace')?.click();
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const card = document.querySelector('[data-node-id="' + reviewer + '"]');
        if (card instanceof HTMLElement && card.style.left === "1960px") break;
        await pause(25);
      }
      document.querySelector('button[aria-label="Enquadrar tudo"]')?.click();
      const minimap = document.querySelector('button[aria-label="Minimapa"][aria-pressed="true"]');
      if (minimap instanceof HTMLButtonElement) minimap.click();
      await pause(750);
      return true;
    })()`,
    true
  );
  if (arranged !== true) throw new Error("Final workspace could not be arranged for approval");
}

async function captureFinalFrame(
  window: BrowserWindow,
  artifactsDirectory: string,
  fileName: string
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const image = await window.webContents.capturePage();
      if (!image.isEmpty()) {
        await writeFile(join(artifactsDirectory, fileName), image.toPNG());
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not capture ${fileName}`);
}

function requiredFinalEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(`${name} is required for final journey`);
  return value;
}

function terminalAnsiCsiPattern(): RegExp {
  // Build the escape byte explicitly so the diagnostic sanitizer remains lint-safe while matching
  // the same ECMA-48 CSI sequences emitted by the real provider TUIs.
  return new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "g");
}

function finalRendererJourney(input: {
  readonly projectDirectory: string;
  readonly workspaceName: string;
  readonly mission: string;
}): Promise<{
  readonly workspaceId: string;
  readonly compazioId: string;
  readonly initialCanvasEmpty: boolean;
  readonly inputFrames: readonly {
    readonly length: number;
    readonly bracketed: boolean;
    readonly enter: boolean;
    readonly written: boolean;
  }[];
}> {
  const pause = (milliseconds: number) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
  const waitFor = async (
    predicate: () => boolean | Promise<boolean>,
    label: string,
    attempts = 18_000
  ): Promise<void> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await predicate()) return;
      await pause(100);
    }
    const diagnosticOutput = String(
      (window as typeof window & { __compazioFinalTerminalOutput?: string })
        .__compazioFinalTerminalOutput ?? ""
    ).slice(-4_000);
    throw new Error(
      `Final journey timed out waiting for ${label}: ${JSON.stringify(diagnosticOutput)}`
    );
  };
  const setValue = (
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    value: string
  ): void => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  return (async () => {
    const create = document.querySelector('[data-testid="v2-create-workspace"]');
    if (!(create instanceof HTMLButtonElement)) throw new Error("workspace create control missing");
    create.click();
    await waitFor(
      () => document.querySelector('.v2-workspace-dialog[role="dialog"]') !== null,
      "workspace dialog"
    );
    const workspaceDialog = document.querySelector(".v2-workspace-dialog");
    const name = workspaceDialog?.querySelector('input[placeholder="Ex.: Landing page"]');
    const chooseDirectory = [...(workspaceDialog?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Escolher pasta"
    );
    if (!(name instanceof HTMLInputElement) || !(chooseDirectory instanceof HTMLButtonElement))
      throw new Error("workspace setup controls missing");
    setValue(name, input.workspaceName);
    chooseDirectory.click();
    await waitFor(
      () =>
        workspaceDialog?.querySelector(".v2-directory-picker strong")?.textContent?.trim() ===
        input.projectDirectory,
      "native folder picker selection"
    );
    const submitWorkspace = workspaceDialog?.querySelector('button[type="submit"]');
    if (!(submitWorkspace instanceof HTMLButtonElement) || submitWorkspace.disabled)
      throw new Error("workspace submit is unavailable after native picker selection");
    submitWorkspace.click();
    await waitFor(
      async () =>
        (await window.compazioV2.workspace.list()).workspaces.some(
          (item) => item.name === input.workspaceName
        ),
      "workspace created through UI"
    );
    const listing = await window.compazioV2.workspace.list();
    const summary = listing.workspaces.find((item) => item.name === input.workspaceName);
    if (summary === undefined) throw new Error("created workspace not listed");
    const emptyWorkspace = await window.compazioV2.workspace.open({ workspaceId: summary.id });
    if (emptyWorkspace.workingDirectory !== input.projectDirectory)
      throw new Error("native folder picker did not select the approved final-journey project");
    const initialCanvasEmpty =
      emptyWorkspace.nodes.length === 0 && emptyWorkspace.edges.length === 0;
    if (!initialCanvasEmpty) throw new Error("new workspace canvas is not empty");

    // Let the renderer-owned provider preflight settle before opening the controlled dialog. The
    // dialog itself still performs the real installed/authenticated gate and never creates a node
    // while that state is unknown.
    await pause(2_000);

    const addTerminal = document.querySelector('[data-testid="v2-add-terminal"]');
    if (!(addTerminal instanceof HTMLButtonElement))
      throw new Error("add terminal control missing");
    addTerminal.click();
    await waitFor(
      () => document.querySelector('form[aria-label="Novo terminal de agente"]') !== null,
      "agent terminal dialog"
    );
    const terminalDialog = document.querySelector('form[aria-label="Novo terminal de agente"]');
    const agent = terminalDialog?.querySelector('[data-testid="v2-agent-select"]');
    const compazio = terminalDialog?.querySelector('[data-testid="v2-terminal-coordinator"]');
    if (!(agent instanceof HTMLSelectElement) || !(compazio instanceof HTMLInputElement))
      throw new Error("Codex Compazio setup controls missing");
    setValue(agent, "codex");
    await pause(0);
    if (!compazio.checked) compazio.click();
    await waitFor(() => {
      const submit = terminalDialog?.querySelector('button[type="submit"]');
      return submit instanceof HTMLButtonElement && !submit.disabled;
    }, "Codex availability preflight");
    const submitTerminal = terminalDialog?.querySelector('button[type="submit"]');
    if (!(submitTerminal instanceof HTMLButtonElement) || submitTerminal.disabled)
      throw new Error("Codex Compazio submit is unavailable");
    submitTerminal.click();
    await waitFor(async () => {
      const workspace = await window.compazioV2.workspace.open({ workspaceId: summary.id });
      return workspace.nodes.some(
        (node) =>
          node.type === "terminal" && node.agentConfig.agentId === "codex" && node.isCompazio
      );
    }, "real Codex Compazio terminal");
    const started = await window.compazioV2.workspace.open({ workspaceId: summary.id });
    const root = started.nodes.find(
      (node) => node.type === "terminal" && node.agentConfig.agentId === "codex" && node.isCompazio
    );
    if (root?.type !== "terminal") throw new Error("Codex Compazio node missing after UI submit");
    const traceWindow = window as typeof window & {
      __compazioFinalTerminalOutput?: string;
      __compazioFinalTerminalOutputs?: Record<string, string>;
      __compazioFinalTerminalInputFrames?: {
        length: number;
        bracketed: boolean;
        enter: boolean;
        written: boolean;
      }[];
    };
    traceWindow.__compazioFinalTerminalOutput = "";
    traceWindow.__compazioFinalTerminalOutputs = {};
    traceWindow.__compazioFinalTerminalInputFrames = [];
    window.compazioV2.terminal.onEvent((event) => {
      if (event.type !== "terminal.output") return;
      const terminalOutput = traceWindow.__compazioFinalTerminalOutputs ?? {};
      terminalOutput[event.terminalNodeId] =
        `${terminalOutput[event.terminalNodeId] ?? ""}${event.data}`.slice(-24_000);
      traceWindow.__compazioFinalTerminalOutputs = terminalOutput;
      if (event.terminalNodeId === root.id)
        traceWindow.__compazioFinalTerminalOutput =
          `${traceWindow.__compazioFinalTerminalOutput ?? ""}${event.data}`.slice(-12_000);
    });
    await waitFor(
      () => document.querySelector(`[data-node-id="${root.id}"] .xterm-helper-textarea`) !== null,
      "Codex PTY ready"
    );
    for (
      let attempt = 0;
      attempt < 800 &&
      !traceWindow.__compazioFinalTerminalOutput?.includes(
        "Do you trust the contents of this directory?"
      ) &&
      !traceWindow.__compazioFinalTerminalOutput?.includes("›");
      attempt += 1
    ) {
      await pause(25);
    }
    if (
      traceWindow.__compazioFinalTerminalOutput?.includes(
        "Do you trust the contents of this directory?"
      )
    ) {
      const opened = await window.compazioV2.workspace.open({ workspaceId: summary.id });
      const active = opened.nodes.find((node) => node.type === "terminal" && node.id === root.id);
      if (active?.type !== "terminal" || active.sessionId === undefined)
        throw new Error("Codex trust prompt has no active final-journey session");
      await window.compazioV2.terminal.write({
        workspaceId: summary.id,
        nodeId: active.id,
        sessionId: active.sessionId,
        data: "\r"
      });
    }
    // Codex starts its configured MCP servers when it receives its first interactive mission.
    // Wait for the actual input-ready terminal surface (and never a trust or startup frame), then
    // send the one user mission through Prompt Composer.
    await pause(8_000);
    await waitFor(
      () => {
        const terminalOutput = traceWindow.__compazioFinalTerminalOutput ?? "";
        const promptIndex = terminalOutput.lastIndexOf("›");
        return (
          promptIndex >= 0 &&
          promptIndex >
            terminalOutput.lastIndexOf("Do you trust the contents of this directory?") &&
          promptIndex > terminalOutput.lastIndexOf("Starting MCP servers")
        );
      },
      "Codex interactive UI ready before the sole user mission",
      1_200
    );
    const rootCard = document.querySelector(`[data-node-id="${root.id}"]`);
    if (!(rootCard instanceof HTMLElement)) throw new Error("Codex node card missing");
    rootCard.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    await waitFor(() => {
      const compose = document.querySelector('[aria-label="Compor prompt"]');
      return compose instanceof HTMLButtonElement && !compose.disabled;
    }, "Prompt Composer for Codex");
    const compose = document.querySelector('[aria-label="Compor prompt"]');
    if (!(compose instanceof HTMLButtonElement)) throw new Error("compose control missing");
    compose.click();
    await waitFor(
      () => document.querySelector('aside[aria-label="Compositor de prompt"] textarea') !== null,
      "Prompt Composer dialog"
    );
    const composer = document.querySelector('aside[aria-label="Compositor de prompt"]');
    const textarea = composer?.querySelector("textarea");
    const send = composer?.querySelector('button[aria-label="Enviar prompt"]');
    if (!(textarea instanceof HTMLTextAreaElement) || !(send instanceof HTMLButtonElement))
      throw new Error("Prompt Composer controls missing");
    setValue(textarea, input.mission);
    if (send.disabled) throw new Error("single user mission is unexpectedly disabled");
    send.click();
    await waitFor(
      () => document.querySelector('aside[aria-label="Compositor de prompt"]') === null,
      "single mission accepted by Codex"
    );
    const inputFrames = traceWindow.__compazioFinalTerminalInputFrames ?? [];
    if (
      !inputFrames.some((frame) => frame.length > 1_000 && frame.bracketed && frame.written) ||
      inputFrames.filter((frame) => frame.enter && frame.written).length < 2
    )
      throw new Error(
        `xterm did not write the complete Codex mission and both submit strokes: ${JSON.stringify(inputFrames)}`
      );
    return {
      workspaceId: summary.id,
      compazioId: root.id,
      initialCanvasEmpty,
      inputFrames
    };
  })();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for V2 smoke`);
  }
  return value;
}

function requiredPhase():
  | "create"
  | "compazio"
  | "compazio-codex"
  | "compazio-mixed"
  | "compazio-reload"
  | "performance"
  | "ux"
  | "terminal"
  | "multi-select"
  | "reload"
  | "cleanup"
  | "files"
  | "real"
  | "real-tui"
  | "license-free"
  | "license-cycle"
  | "recovery-write"
  | "recovery-verify"
  | "atomic-recovery-write"
  | "atomic-recovery-verify"
  | "team-recovery-write"
  | "team-recovery-verify"
  | "single-instance-hold" {
  const phase = requiredEnvironment("COMPAZIO_V2_SMOKE_PHASE");
  if (
    phase !== "create" &&
    phase !== "compazio" &&
    phase !== "compazio-codex" &&
    phase !== "compazio-mixed" &&
    phase !== "compazio-reload" &&
    phase !== "performance" &&
    phase !== "ux" &&
    phase !== "terminal" &&
    phase !== "multi-select" &&
    phase !== "reload" &&
    phase !== "cleanup" &&
    phase !== "files" &&
    phase !== "real" &&
    phase !== "real-tui" &&
    phase !== "license-free" &&
    phase !== "license-cycle" &&
    phase !== "recovery-write" &&
    phase !== "recovery-verify" &&
    phase !== "atomic-recovery-write" &&
    phase !== "atomic-recovery-verify" &&
    phase !== "team-recovery-write" &&
    phase !== "team-recovery-verify" &&
    phase !== "single-instance-hold"
  ) {
    throw new Error(
      "COMPAZIO_V2_SMOKE_PHASE must be create, compazio, compazio-codex, compazio-mixed, compazio-reload, performance, ux, terminal, multi-select, reload, cleanup, files, real, real-tui, license-free, license-cycle, recovery-write, recovery-verify, atomic-recovery-write, atomic-recovery-verify, team-recovery-write, team-recovery-verify or single-instance-hold"
    );
  }
  return phase;
}

async function waitForWindowState(
  window: BrowserWindow,
  predicate: () => boolean,
  label: string
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`V2 window did not ${label}`);
}

async function waitForRendererFlag(
  window: BrowserWindow,
  name: string,
  attempts = 240
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ready = await window.webContents.executeJavaScript(
      `window[${JSON.stringify(name)}] === true`,
      true
    );
    if (ready === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`V2 renderer flag did not become ready: ${name}`);
}

async function waitForRenderer(window: BrowserWindow): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await window.webContents.executeJavaScript(
      "typeof window.compazioV2 === 'object' && document.querySelector('[data-testid=\\\"v2-create-workspace\\\"]') !== null",
      true
    );
    if (ready === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("V2 renderer did not become ready");
}

function isPosition(value: unknown): value is { readonly x: number; readonly y: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value &&
    typeof value.x === "number" &&
    typeof value.y === "number"
  );
}

function isFreeLicenseResult(value: unknown): value is {
  readonly workspaceDialogOpened: boolean;
  readonly firstCreated: boolean;
  readonly secondCreated: boolean;
  readonly licenseDialogOpened: boolean;
  readonly workspaceCount: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "workspaceDialogOpened" in value &&
    "firstCreated" in value &&
    "secondCreated" in value &&
    "licenseDialogOpened" in value &&
    "workspaceCount" in value &&
    typeof value.workspaceDialogOpened === "boolean" &&
    typeof value.firstCreated === "boolean" &&
    typeof value.secondCreated === "boolean" &&
    typeof value.licenseDialogOpened === "boolean" &&
    typeof value.workspaceCount === "number"
  );
}

function isLicenseCycleResult(value: unknown): value is {
  readonly beforeFree: boolean;
  readonly activated: boolean;
  readonly existingPreserved: boolean;
  readonly revoked: boolean;
  readonly denied: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "beforeFree" in value &&
    "activated" in value &&
    "existingPreserved" in value &&
    "revoked" in value &&
    "denied" in value &&
    value.beforeFree === true &&
    value.activated === true &&
    value.existingPreserved === true &&
    value.revoked === true &&
    value.denied === false
  );
}

function isRecoveryWriteResult(value: unknown): value is {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly terminalId: string;
  readonly presetId: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "workspaceId" in value &&
    "noteId" in value &&
    "terminalId" in value &&
    "presetId" in value &&
    typeof value.workspaceId === "string" &&
    typeof value.noteId === "string" &&
    typeof value.terminalId === "string" &&
    typeof value.presetId === "string"
  );
}

function isRecoveryVerifyResult(value: unknown): value is {
  readonly workspaceRestored: boolean;
  readonly workspaceRenderedDirectly: boolean;
  readonly noteRestored: boolean;
  readonly edgeRestored: boolean;
  readonly portalRestored: boolean;
  readonly presetRestored: boolean;
  readonly positionRestored: boolean;
  readonly staleSessionCleared: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "workspaceRestored" in value &&
    "workspaceRenderedDirectly" in value &&
    "noteRestored" in value &&
    "edgeRestored" in value &&
    "portalRestored" in value &&
    "presetRestored" in value &&
    "positionRestored" in value &&
    "staleSessionCleared" in value &&
    value.workspaceRestored === true &&
    value.workspaceRenderedDirectly === true &&
    value.noteRestored === true &&
    value.edgeRestored === true &&
    value.portalRestored === true &&
    value.presetRestored === true &&
    value.positionRestored === true &&
    value.staleSessionCleared === true
  );
}

function isAtomicRecoveryVerifyResult(value: unknown): value is {
  readonly firstPresetRestored: boolean;
  readonly replacementPresetRestored: boolean;
  readonly workspaceRestored: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "firstPresetRestored" in value &&
    "replacementPresetRestored" in value &&
    "workspaceRestored" in value &&
    value.firstPresetRestored === true &&
    value.replacementPresetRestored === true &&
    value.workspaceRestored === true
  );
}

function isTeamRecoveryWriteResult(value: unknown): value is {
  readonly workspaceId: string;
  readonly runId: string;
  readonly activeTask: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "workspaceId" in value &&
    "runId" in value &&
    "activeTask" in value &&
    typeof value.workspaceId === "string" &&
    typeof value.runId === "string" &&
    value.activeTask === true
  );
}

function isTeamRecoveryVerifyResult(value: unknown): value is {
  readonly workspaceRestored: boolean;
  readonly runRecovered: boolean;
  readonly tasksStopped: boolean;
  readonly recoveryEventRecorded: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "workspaceRestored" in value &&
    "runRecovered" in value &&
    "tasksStopped" in value &&
    "recoveryEventRecorded" in value &&
    value.workspaceRestored === true &&
    value.runRecovered === true &&
    value.tasksStopped === true &&
    value.recoveryEventRecorded === true
  );
}

function isCreatedResult(value: unknown): value is {
  readonly output: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly agentCount: number;
  readonly roleCount: number;
  readonly taskCount: number;
  readonly activityCount: number;
  readonly completed: boolean;
  readonly nonOverlapping: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "output" in value &&
    "position" in value &&
    "agentCount" in value &&
    "roleCount" in value &&
    "taskCount" in value &&
    "activityCount" in value &&
    "completed" in value &&
    "nonOverlapping" in value &&
    typeof value.output === "string" &&
    typeof value.agentCount === "number" &&
    typeof value.roleCount === "number" &&
    typeof value.taskCount === "number" &&
    typeof value.activityCount === "number" &&
    typeof value.completed === "boolean" &&
    typeof value.nonOverlapping === "boolean" &&
    isPosition(value.position)
  );
}

function isCompazioResult(value: unknown): value is {
  readonly legacyCliBlocked: boolean;
  readonly compazioEnabled: boolean;
  readonly recruited: boolean;
  readonly connectionCreated: boolean;
  readonly roleCreated: boolean;
  readonly taskCompleted: boolean;
  readonly resultReturned: boolean;
  readonly messagesDelivered: boolean;
  readonly dismissed: boolean;
  readonly workerResourcesReleased: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "legacyCliBlocked" in value &&
    "compazioEnabled" in value &&
    "recruited" in value &&
    "connectionCreated" in value &&
    "roleCreated" in value &&
    "taskCompleted" in value &&
    "resultReturned" in value &&
    "messagesDelivered" in value &&
    "dismissed" in value &&
    "workerResourcesReleased" in value &&
    typeof value.legacyCliBlocked === "boolean" &&
    typeof value.compazioEnabled === "boolean" &&
    typeof value.recruited === "boolean" &&
    typeof value.connectionCreated === "boolean" &&
    typeof value.roleCreated === "boolean" &&
    typeof value.taskCompleted === "boolean" &&
    typeof value.resultReturned === "boolean" &&
    typeof value.messagesDelivered === "boolean" &&
    typeof value.dismissed === "boolean" &&
    typeof value.workerResourcesReleased === "boolean"
  );
}

function isMixedCompazioResult(value: unknown): value is {
  readonly teamRunCompleted: boolean;
  readonly dependenciesReleased: boolean;
  readonly workerContextDelivered: boolean;
  readonly reviewReturned: boolean;
  readonly clarificationRouted: boolean;
  readonly groupCreated: boolean;
  readonly dismissed: boolean;
  readonly workerResourcesReleased: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "teamRunCompleted" in value &&
    "dependenciesReleased" in value &&
    "workerContextDelivered" in value &&
    "reviewReturned" in value &&
    "clarificationRouted" in value &&
    "groupCreated" in value &&
    "dismissed" in value &&
    "workerResourcesReleased" in value &&
    typeof value.teamRunCompleted === "boolean" &&
    typeof value.dependenciesReleased === "boolean" &&
    typeof value.workerContextDelivered === "boolean" &&
    typeof value.reviewReturned === "boolean" &&
    typeof value.clarificationRouted === "boolean" &&
    typeof value.groupCreated === "boolean" &&
    typeof value.dismissed === "boolean" &&
    typeof value.workerResourcesReleased === "boolean"
  );
}

function isCompazioReloadedResult(value: unknown): value is {
  readonly historyPreserved: boolean;
  readonly nodesRemaining: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "historyPreserved" in value &&
    "nodesRemaining" in value &&
    typeof value.historyPreserved === "boolean" &&
    typeof value.nodesRemaining === "number"
  );
}

function isRealAgentResult(value: unknown): value is {
  readonly noteCreated: boolean;
  readonly childCreated: boolean;
  readonly connected: boolean;
  readonly childWroteNote: boolean;
  readonly responseReturned: boolean;
  readonly nodesRemaining: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "noteCreated" in value &&
    "childCreated" in value &&
    "connected" in value &&
    "childWroteNote" in value &&
    "responseReturned" in value &&
    "nodesRemaining" in value &&
    typeof value.noteCreated === "boolean" &&
    typeof value.childCreated === "boolean" &&
    typeof value.connected === "boolean" &&
    typeof value.childWroteNote === "boolean" &&
    typeof value.responseReturned === "boolean" &&
    typeof value.nodesRemaining === "number"
  );
}

function isPerformanceResult(value: unknown): value is {
  readonly terminalCount: number;
  readonly noteCount: number;
  readonly edgeCount: number;
  readonly mutationDurationMs: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "terminalCount" in value &&
    "noteCount" in value &&
    "edgeCount" in value &&
    "mutationDurationMs" in value &&
    typeof value.terminalCount === "number" &&
    typeof value.noteCount === "number" &&
    typeof value.edgeCount === "number" &&
    typeof value.mutationDurationMs === "number"
  );
}

function isMultiSelectResult(value: unknown): value is Record<string, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    "ctrlClick" in value &&
    "contextMenu" in value &&
    "confirmation" in value &&
    "deletion" in value &&
    Object.values(value).every((item) => item === true)
  );
}

function isUxResult(value: unknown): value is Record<string, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    "logo" in value &&
    "inspectorHiddenByDefault" in value &&
    "inspectorCanOpen" in value &&
    "shortcutsOpen" in value &&
    "multiSelect" in value &&
    "groupWithoutPrompt" in value &&
    "edgeContextDisconnect" in value &&
    "dockButtons" in value &&
    "noteWheelDoesNotZoom" in value &&
    Object.values(value).every((item) => typeof item === "boolean")
  );
}

function isTerminalResult(value: unknown): value is Record<string, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    "promptNativeEditing" in value &&
    "typing" in value &&
    "backspace" in value &&
    "firstCharacterDeletion" in value &&
    "deleteHomeEnd" in value &&
    "mouseSelection" in value &&
    "unicode" in value &&
    "boxDrawing" in value &&
    "ansi" in value &&
    "multilinePaste" in value &&
    "pasteCtrlV" in value &&
    "pasteCtrlShiftV" in value &&
    "pasteShiftInsert" in value &&
    "ctrlShiftA" in value &&
    "ctrlCSelection" in value &&
    "ctrlCSigint" in value &&
    "resize" in value &&
    "resizeStorm100" in value &&
    "dragIsolation" in value &&
    "terminalWheelIsolation" in value &&
    "terminalScrollback" in value &&
    "scaledTuiMouse" in value &&
    "canvasZoom" in value &&
    Object.values(value).every((item) => typeof item === "boolean")
  );
}

function isReloadedResult(value: unknown): value is {
  readonly position: { readonly x: number; readonly y: number };
  readonly nodesRemaining: number;
  readonly inspector: boolean;
  readonly teamSummary: boolean;
  readonly timeline: boolean;
  readonly policyId: string;
  readonly terminalCount: number;
  readonly noteCount: number;
  readonly edgeCount: number;
  readonly frameDurationMs: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "position" in value &&
    "nodesRemaining" in value &&
    "inspector" in value &&
    "teamSummary" in value &&
    "timeline" in value &&
    "policyId" in value &&
    "terminalCount" in value &&
    "noteCount" in value &&
    "edgeCount" in value &&
    "frameDurationMs" in value &&
    isPosition(value.position) &&
    typeof value.nodesRemaining === "number" &&
    typeof value.inspector === "boolean" &&
    typeof value.teamSummary === "boolean" &&
    typeof value.timeline === "boolean" &&
    typeof value.policyId === "string" &&
    typeof value.terminalCount === "number" &&
    typeof value.noteCount === "number" &&
    typeof value.edgeCount === "number" &&
    typeof value.frameDurationMs === "number"
  );
}

function isCleanupResult(value: unknown): value is {
  readonly nodesRemaining: number;
  readonly runsRemaining: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodesRemaining" in value &&
    "runsRemaining" in value &&
    typeof value.nodesRemaining === "number" &&
    typeof value.runsRemaining === "number"
  );
}

function isFilesResult(value: unknown): value is {
  readonly treeCreated: boolean;
  readonly saved: boolean;
  readonly diffIncludesChange: boolean;
  readonly contextDelivered: boolean;
  readonly previewMissing: boolean;
  readonly clean: boolean;
  readonly nodesRemaining: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "treeCreated" in value &&
    "saved" in value &&
    "diffIncludesChange" in value &&
    "contextDelivered" in value &&
    "previewMissing" in value &&
    "clean" in value &&
    "nodesRemaining" in value &&
    typeof value.treeCreated === "boolean" &&
    typeof value.saved === "boolean" &&
    typeof value.diffIncludesChange === "boolean" &&
    typeof value.contextDelivered === "boolean" &&
    typeof value.previewMissing === "boolean" &&
    typeof value.clean === "boolean" &&
    typeof value.nodesRemaining === "number"
  );
}
