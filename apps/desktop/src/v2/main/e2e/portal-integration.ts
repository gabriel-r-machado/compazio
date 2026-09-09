import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addPortalNode,
  addTerminalNode,
  addVisualEdge,
  createWorkspace
} from "@forgedeck/compazio-v2-domain";
import type { PortalNode, Workspace } from "@forgedeck/compazio-v2-domain";
import type { BrowserWindow } from "electron";

import { authorizePortalControl } from "../portal-authorization";
import { PortalError } from "../portal-operations";
import { PortalRecoveryPolicy } from "../portal-recovery";
import { PortalRuntimeManager } from "../portal-runtime-manager";
import { startPortalFixture, type PortalFixture } from "./portal-fixture";

interface Check {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];
let identifier = 0;

const dependencies = {
  createId: () => `portal-e2e-${++identifier}`,
  now: () => new Date().toISOString()
};

function record(step: string, ok: boolean, detail: unknown = ""): void {
  checks.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  if (!ok) console.error(`FAIL ${step}: ${JSON.stringify(detail)}`);
  else console.info(`ok   ${step}`);
}

async function expectFailure(
  step: string,
  code: string,
  work: () => Promise<unknown>
): Promise<void> {
  try {
    const value = await work();
    record(step, false, { expected: code, received: value });
  } catch (error) {
    const actual = error instanceof PortalError ? error.code : String(error);
    record(step, actual === code, { expected: code, actual });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The Wave 4 integration scenario. It runs inside Electron because a Portal is a real
 * WebContentsView: the fixture is local, deterministic and offline, and every assertion here is
 * about behaviour a unit test cannot reach — real navigation, real input, real crashes, real files.
 */
export async function runPortalIntegration(window: BrowserWindow): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "compazio-portal-integration-"));
  const downloads = join(root, "downloads");
  const temporary = join(root, "temp");
  let fixture: PortalFixture | undefined;
  let manager: PortalRuntimeManager | undefined;
  let downloadDecision: { accepted: boolean; destination?: string; overwrite?: boolean } = {
    accepted: false
  };
  const events: { type: string; metadata: Record<string, unknown> }[] = [];
  try {
    await writeFile(join(root, ".keep"), "", "utf8");
    // capturePage needs a composited window; an invisible one answers with an empty frame.
    window.show();
    fixture = await startPortalFixture();
    record("1. fixture iniciada", fixture.baseUrl.startsWith("http://127.0.0.1:"), fixture.baseUrl);

    let workspace: Workspace = createWorkspace(
      { name: "Portais", workingDirectory: root },
      dependencies
    );
    workspace = addTerminalNode(workspace, { title: "Líder", orchestrator: true }, dependencies);
    workspace = addPortalNode(workspace, { url: fixture.baseUrl }, dependencies);
    const terminalId = workspace.nodes.find((node) => node.type === "terminal")?.id ?? "";
    const portal = workspace.nodes.find((node): node is PortalNode => node.type === "portal");
    if (portal === undefined) throw new Error("portal fixture ausente");
    record("2. workspace criado", terminalId !== "" && portal.id !== "", {
      terminalId,
      portalId: portal.id
    });

    manager = new PortalRuntimeManager({
      getWindow: () => window,
      tempDirectory: temporary,
      downloadDirectory: downloads,
      testHooks: true,
      persist: async () => undefined,
      onEvent: (type, metadata) => events.push({ type, metadata: { ...metadata } }),
      requestDownloadDecision: async () => downloadDecision
    });
    const runtime = manager;
    runtime.setWindowState({
      activeWorkspaceId: workspace.id,
      canvasViewport: { x: 0, y: 0, width: 1_200, height: 800 }
    });

    // 3-5: create the Portal and open the page.
    const created = await runtime.ensure(workspace.id, portal);
    runtime.setBounds(workspace.id, portal.id, {
      x: 20,
      y: 20,
      width: 900,
      height: 600,
      visible: true
    });
    record("3. Portal criado", created.portalId === portal.id, created.state);
    record("4. página aberta", created.url.startsWith(fixture.baseUrl), created.url);
    const opened = runtime.get(workspace.id, portal.id);
    record("5. título confirmado", opened.title === "Portal fixture", opened.title);

    // 6-8: navigation and history.
    await runtime.navigate(workspace.id, portal.id, `${fixture.baseUrl}/second`);
    record(
      "6. navegou",
      runtime.get(workspace.id, portal.id).title === "Segunda",
      runtime.get(workspace.id, portal.id).title
    );
    await runtime.command(workspace.id, portal.id, "back");
    record(
      "7. voltou",
      runtime.get(workspace.id, portal.id).title === "Portal fixture",
      runtime.get(workspace.id, portal.id).title
    );
    await runtime.command(workspace.id, portal.id, "forward");
    record(
      "8. avançou",
      runtime.get(workspace.id, portal.id).title === "Segunda",
      runtime.get(workspace.id, portal.id).title
    );
    await runtime.navigate(workspace.id, portal.id, fixture.baseUrl);

    // 9-11: a terminal without a connection controls nothing.
    const unauthorized = authorizePortalControl(workspace, {
      terminalNodeId: terminalId,
      portalId: portal.id
    });
    record(
      "9-11. sem conexão o controle é negado",
      !unauthorized.ok && unauthorized.code === "PORTAL_NOT_CONNECTED",
      unauthorized
    );

    // 12-13: connect and list.
    workspace = addVisualEdge(workspace, terminalId, portal.id, dependencies, ["portal-control"]);
    const authorized = authorizePortalControl(workspace, {
      terminalNodeId: terminalId,
      portalId: portal.id
    });
    record("12. conexão portal-control concede controle", authorized.ok, authorized);
    record(
      "13. Portal listado",
      runtime.list(workspace.id).length === 1,
      runtime.list(workspace.id).length
    );

    // 14-15: click by accessible role and name.
    await runtime.automation(workspace.id, portal.id, "click", {
      role: "button",
      name: "Incrementar"
    });
    const counter = await runtime.automation(workspace.id, portal.id, "dom", { query: "#count" });
    const counterText = isRecord(counter) && isRecord(counter.tree) ? counter.tree.text : "";
    record("14-15. clique incrementou o contador", counterText === "1", counterText);
    await runtime.automation(workspace.id, portal.id, "press", {
      key: "Space",
      selector: "#increment"
    });
    const spaceCounter = await runtime.automation(workspace.id, portal.id, "dom", {
      query: "#count"
    });
    const spaceCounterText =
      isRecord(spaceCounter) && isRecord(spaceCounter.tree) ? spaceCounter.tree.text : "";
    record("15b. Space ativa botão como teclado real", spaceCounterText === "2", spaceCounterText);
    const tabbed = await runtime.automation(workspace.id, portal.id, "press", { key: "Tab" });
    const tabTarget = isRecord(tabbed) && isRecord(tabbed.target) ? tabbed.target : {};
    record("15c. Tab avança o foco como teclado real", tabTarget.id === "name", tabTarget);
    const reverseTabbed = await runtime.automation(workspace.id, portal.id, "press", {
      key: "Tab",
      modifiers: ["shift"]
    });
    const reverseTabTarget =
      isRecord(reverseTabbed) && isRecord(reverseTabbed.target) ? reverseTabbed.target : {};
    record(
      "15d. Shift+Tab retorna o foco como teclado real",
      reverseTabTarget.id === "increment",
      reverseTabTarget
    );

    // 16-18: type and submit.
    await runtime.automation(workspace.id, portal.id, "type", {
      label: "Nome",
      text: "Compazio",
      clear: true
    });
    await runtime.automation(workspace.id, portal.id, "click", { role: "button", name: "Enviar" });
    const result = await runtime.automation(workspace.id, portal.id, "dom", { query: "#result" });
    const resultText = isRecord(result) && isRecord(result.tree) ? result.tree.text : "";
    record("16-18. formulário enviado", resultText === "Olá, Compazio", resultText);

    // 19: press a validated key, and refuse anything else.
    const pressed = await runtime.automation(workspace.id, portal.id, "press", {
      key: "Enter",
      selector: "#name"
    });
    record("19. tecla pressionada", isRecord(pressed) && pressed.key === "Enter", pressed);
    await expectFailure("19b. tecla arbitrária recusada", "PORTAL_INVALID_KEY", () =>
      runtime.automation(workspace.id, portal.id, "press", { key: "F12" })
    );

    // 20: scroll.
    const scrolled = await runtime.automation(workspace.id, portal.id, "scroll", {
      direction: "down",
      amount: 600
    });
    const viewport = isRecord(scrolled) && isRecord(scrolled.viewport) ? scrolled.viewport : {};
    record("20. rolagem aplicada", Number(viewport.scrollY ?? 0) > 0, viewport);

    // 21: bounded DOM.
    const dom = await runtime.automation(workspace.id, portal.id, "dom", {});
    const nodes = isRecord(dom) ? Number(dom.nodes ?? 0) : 0;
    const serialized = JSON.stringify(dom);
    record(
      "21. DOM limitado e sanitizado",
      nodes > 0 && !serialized.includes("<script") && !serialized.includes("localStorage"),
      { nodes }
    );
    await expectFailure("21b. limite de DOM respeitado", "PORTAL_DOM_LIMIT_EXCEEDED", () =>
      runtime.automation(workspace.id, portal.id, "dom", { limits: { maxNodes: 2 } })
    );

    // 22: accessibility tree and search.
    const tree = await runtime.automation(workspace.id, portal.id, "accessibility", {});
    const treeOk = isRecord(tree) && isRecord(tree.tree);
    const search = await runtime.automation(workspace.id, portal.id, "accessibility", {
      filter: { role: "button", name: "Incrementar" }
    });
    const matches = isRecord(search) && Array.isArray(search.matches) ? search.matches : [];
    record("22. accessibility localiza por role e nome", treeOk && matches.length === 1, {
      matches: matches.length
    });

    // 23-24: console buffer.
    await runtime.automation(workspace.id, portal.id, "click", { selector: "#log" });
    await runtime.automation(workspace.id, portal.id, "click", { selector: "#error" });
    const logs = runtime.consoleMessages(workspace.id, portal.id, { limit: 50 });
    const errors = runtime.consoleMessages(workspace.id, portal.id, { levels: ["error"] });
    record(
      "23-24. console capturado com filtro",
      logs.entries.some((entry) => entry.message.includes("fixture log")) &&
        errors.entries.every((entry) => entry.level === "error") &&
        errors.entries.length >= 1,
      { stored: logs.stored, errors: errors.entries.length }
    );

    // 25: screenshot.
    // On Windows, capturePage requires a composited display surface. Automation keeps the
    // WebContents focused, but the Electron harness itself may have lost window activation while
    // the fixture was processing events. Re-activate the owned test window instead of widening the
    // runtime retry budget or masking a compositor failure.
    window.show();
    window.focus();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    let screenshot: Awaited<ReturnType<PortalRuntimeManager["screenshot"]>>;
    try {
      screenshot = await runtime.screenshot(workspace.id, portal.id);
    } catch (error) {
      console.error("Portal screenshot diagnostics", {
        error: error instanceof Error ? error.message : String(error),
        portal: runtime.get(workspace.id, portal.id),
        manager: runtime.diagnostics(),
        window: {
          visible: window.isVisible(),
          focused: window.isFocused(),
          minimized: window.isMinimized(),
          bounds: window.getBounds()
        }
      });
      throw error;
    }
    const bytes = await readFile(screenshot.path);
    record(
      "25. screenshot gerado no diretório gerenciado",
      screenshot.path.startsWith(temporary) && bytes.subarray(1, 4).toString() === "PNG",
      { bytes: bytes.byteLength }
    );

    // 26: timeout on the slow route.
    await expectFailure("26. timeout na rota lenta", "PORTAL_TIMEOUT", () =>
      runtime.navigate(workspace.id, portal.id, `${fixture?.baseUrl ?? ""}/slow`, {
        timeoutMs: 300
      })
    );

    // 27: explicit cancellation, twice, without a second failure.
    const correlationId = "cancelamento-1";
    const pending = runtime.navigate(workspace.id, portal.id, `${fixture.baseUrl}/slow`, {
      correlationId,
      timeoutMs: 30_000
    });
    const cancelled = await new Promise<{ first: boolean; second: boolean; code: string }>(
      (resolve) => {
        setTimeout(() => {
          const first = runtime.cancel(correlationId);
          const second = runtime.cancel(correlationId);
          pending
            .then(() => resolve({ first, second, code: "sem-erro" }))
            .catch((error: unknown) =>
              resolve({
                first,
                second,
                code: error instanceof PortalError ? error.code : String(error)
              })
            );
        }, 100);
      }
    );
    record(
      "27. cancelamento é idempotente",
      cancelled.first && !cancelled.second && cancelled.code === "PORTAL_OPERATION_CANCELLED",
      cancelled
    );
    record(
      "27b. nada pendente",
      runtime.pendingOperations().length === 0,
      runtime.pendingOperations().length
    );
    await runtime.navigate(workspace.id, portal.id, fixture.baseUrl);

    // 28-29: revoking the connection cancels work in flight and refuses the next call.
    const revokedSource = workspace;
    const inFlight = runtime.navigate(workspace.id, portal.id, `${fixture.baseUrl}/slow`, {
      terminalNodeId: terminalId,
      timeoutMs: 30_000
    });
    const revoked = {
      ...workspace,
      edges: workspace.edges.filter((edge) => edge.targetNodeId !== portal.id)
    };
    runtime.onWorkspaceChanged(revokedSource, revoked);
    const revocation = await inFlight
      .then(() => "sem-erro")
      .catch((error: unknown) => (error instanceof PortalError ? error.code : String(error)));
    workspace = revoked;
    const afterRevocation = authorizePortalControl(workspace, {
      terminalNodeId: terminalId,
      portalId: portal.id
    });
    record(
      "28-29. remover a conexão revoga e cancela",
      revocation === "PORTAL_NOT_CONNECTED" && !afterRevocation.ok,
      { revocation, afterRevocation }
    );
    workspace = addVisualEdge(workspace, terminalId, portal.id, dependencies, ["portal-control"]);
    await runtime.navigate(workspace.id, portal.id, fixture.baseUrl);

    // 30-31: popup and permission stay blocked.
    events.length = 0;
    await runtime.automation(workspace.id, portal.id, "click", { selector: "#popup" });
    await runtime.automation(workspace.id, portal.id, "click", { selector: "#permission" });
    await wait(300);
    record(
      "30-31. popup e permissão bloqueados",
      events.some((event) => event.type === "portal.popup.blocked"),
      events.map((event) => event.type)
    );

    // 32: download refused.
    events.length = 0;
    downloadDecision = { accepted: false };
    await runtime.automation(workspace.id, portal.id, "click", { selector: "#download" });
    await wait(700);
    const cancelledDownload = events.some((event) => event.type === "portal.download.cancelled");
    const nothingWritten = (await readdir(downloads).catch(() => [])).length === 0;
    record("32. download cancelado não escreve nada", cancelledDownload && nothingWritten, {
      cancelledDownload,
      nothingWritten
    });

    // 33: download accepted, written where Compazio decided.
    events.length = 0;
    downloadDecision = { accepted: true };
    await runtime.automation(workspace.id, portal.id, "click", { selector: "#download" });
    await wait(1_500);
    const files: string[] = await readdir(downloads).catch(() => []);
    const content =
      files.length === 0
        ? ""
        : await readFile(join(downloads, files[0] ?? ""), "utf8").catch(() => "");
    record(
      "33. download aceito grava o arquivo",
      files.includes("fixture.txt") && content === "download fixture",
      {
        files,
        content
      }
    );

    // 33b: an existing file is never overwritten silently.
    events.length = 0;
    await runtime.automation(workspace.id, portal.id, "click", { selector: "#download" });
    await wait(1_500);
    const afterSecond = await readdir(downloads).catch(() => []);
    record("33b. arquivo existente preservado", afterSecond.length === 2, afterSecond);

    // 34-35: crash and recovery. Recovery starts immediately, so the visible failure is read from
    // the event and from the snapshot's description rather than from the transient state.
    events.length = 0;
    runtime.simulateFailure(workspace.id, portal.id, "render-process-gone");
    const crashState = runtime.list(workspace.id)[0];
    const crashEvent = events.find((event) => event.type === "portal.crashed");
    record(
      "34. crash tem estado visível",
      crashState?.failure !== null &&
        crashEvent !== undefined &&
        String(crashEvent.metadata.reason ?? "").includes("processo") &&
        String(crashEvent.metadata.lastUrl ?? "").startsWith("http://127.0.0.1:"),
      { failure: crashState?.failure, event: crashEvent?.metadata }
    );
    await wait(2_500);
    const recovered = runtime.list(workspace.id)[0];
    record(
      "35. runtime recuperado sem duplicar",
      recovered?.state === "ready" &&
        events.some((event) => event.type === "portal.recovery.started") &&
        events.some((event) => event.type === "portal.recovery.completed"),
      { state: recovered?.state, events: events.map((event) => event.type) }
    );

    // 34b: recovery is budgeted. A page that keeps dying stays visibly failed instead of looping.
    const strictEvents: { type: string; metadata: Record<string, unknown> }[] = [];
    const strict = new PortalRuntimeManager({
      getWindow: () => window,
      tempDirectory: join(temporary, "strict"),
      downloadDirectory: downloads,
      testHooks: true,
      recovery: new PortalRecoveryPolicy({ maxAttempts: 1, cooldownMs: 0 }),
      persist: async () => undefined,
      onEvent: (type, metadata) => strictEvents.push({ type, metadata: { ...metadata } })
    });
    try {
      strict.setWindowState({ activeWorkspaceId: workspace.id });
      await strict.ensure(workspace.id, portal);
      strict.simulateFailure(workspace.id, portal.id, "render-process-gone");
      await wait(1_500);
      strict.simulateFailure(workspace.id, portal.id, "render-process-gone");
      await wait(500);
      const exhausted = strictEvents.filter((event) => event.type === "portal.recovery.failed");
      record(
        "34b. recuperação não entra em laço infinito",
        exhausted.some((event) => event.metadata.reason === "attempts-exhausted") &&
          strictEvents.filter((event) => event.type === "portal.recovery.started").length === 1,
        strictEvents.map((event) => event.type)
      );
      const manual = await strict.recover(workspace.id, portal.id, "recreate");
      record(
        "34c. recriar runtime manualmente reabilita o Portal",
        manual.state === "ready",
        manual.state
      );
    } finally {
      await strict.shutdown();
    }

    // 36-37: replaying the canvas description must not build a second View.
    await runtime.ensure(workspace.id, portal);
    await runtime.ensure(workspace.id, portal);
    const diagnostics = runtime.diagnostics();
    record(
      "36-37. reload do renderer não duplica",
      diagnostics.views === 1 && diagnostics.attachedViews === 1,
      diagnostics
    );

    // z-order: an overlay hides the Portal and closing it brings the surface back.
    const surfaces = runtime.surfaceCoordinator();
    surfaces.openOverlay("command-palette");
    const hidden = surfaces.decisionFor(`${workspace.id}:${portal.id}`);
    surfaces.closeOverlay("command-palette");
    const shown = surfaces.decisionFor(`${workspace.id}:${portal.id}`);
    record(
      "z-order: overlay cobre o Portal e a superfície volta",
      hidden?.visible === false && hidden.attached && shown?.visible === true,
      { hidden: hidden?.reason, shown: shown?.reason }
    );

    // focus: Esc gives the canvas back the keyboard, and Resetar Foco reaches every Portal.
    runtime.focus(workspace.id, portal.id);
    const focused = runtime.focusedPortals().length;
    const released = runtime.resetFocus(workspace.id);
    record(
      "foco: Resetar Foco libera os Portais",
      focused === 1 && released === 1 && runtime.focusedPortals().length === 0,
      {
        focused,
        released
      }
    );

    // session isolation.
    const isolated = addPortalNode(workspace, { url: fixture.baseUrl }, dependencies);
    const second = [...isolated.nodes]
      .reverse()
      .find((node): node is PortalNode => node.type === "portal");
    if (second === undefined) throw new Error("segundo portal ausente");
    workspace = isolated;
    await runtime.ensure(workspace.id, second);
    const firstPartition = runtime.get(workspace.id, portal.id).partition;
    const secondPartition = runtime.get(workspace.id, second.id).partition;
    const shared = addPortalNode(
      workspace,
      { url: fixture.baseUrl, sessionMode: "workspace-shared", sessionKey: "equipe" },
      dependencies
    );
    const third = [...shared.nodes]
      .reverse()
      .find((node): node is PortalNode => node.type === "portal");
    if (third === undefined) throw new Error("terceiro portal ausente");
    workspace = shared;
    await runtime.ensure(workspace.id, third);
    const fourthWorkspace = addPortalNode(
      workspace,
      { url: fixture.baseUrl, sessionMode: "workspace-shared", sessionKey: "equipe" },
      dependencies
    );
    const fourth = [...fourthWorkspace.nodes]
      .reverse()
      .find((node): node is PortalNode => node.type === "portal");
    if (fourth === undefined) throw new Error("quarto portal ausente");
    workspace = fourthWorkspace;
    await runtime.ensure(workspace.id, fourth);
    record(
      "sessões: isoladas separam e compartilhadas unem",
      firstPartition !== secondPartition &&
        runtime.get(workspace.id, third.id).partition ===
          runtime.get(workspace.id, fourth.id).partition,
      {
        firstPartition,
        secondPartition,
        shared: runtime.get(workspace.id, third.id).partition
      }
    );
    await runtime.destroy(workspace.id, second.id);
    await runtime.destroy(workspace.id, third.id);
    await runtime.destroy(workspace.id, fourth.id);

    // 38-39: deleting the Portal cleans the screenshot already created in step 25 and every
    // native resource it owned. A second capture here used to race with Chromium's compositor
    // while the session-isolation fixtures were being torn down; it did not add coverage.
    await runtime.destroy(workspace.id, portal.id);
    const afterDelete = runtime.diagnostics();
    const orphanShots = await runtime.screenshotOrphans();
    record(
      "38-39. exclusão limpa View, listeners, screenshots e operações",
      afterDelete.views === 0 &&
        afterDelete.webContents === 0 &&
        afterDelete.listeners === 0 &&
        afterDelete.pendingOperations === 0 &&
        afterDelete.screenshots === 0 &&
        orphanShots.length === 0,
      { afterDelete, orphanShots }
    );
    await expectFailure("39b. Portal excluído não responde", "PORTAL_NOT_FOUND", async () =>
      runtime.get(workspace.id, portal.id)
    );

    // 40: shutdown leaves nothing behind.
    await runtime.shutdown();
    manager = undefined;
    const afterShutdown = await readdir(temporary).catch(() => []);
    record("40. shutdown sem recursos órfãos", afterShutdown.length === 0, afterShutdown);
  } finally {
    await manager?.shutdown().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  const failures = checks.filter((check) => !check.ok);
  console.info(
    `Portal integration: ${checks.length - failures.length}/${checks.length} verificações`
  );
  if (failures.length > 0)
    throw new Error(`Portal integration falhou: ${JSON.stringify(failures, null, 2)}`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
