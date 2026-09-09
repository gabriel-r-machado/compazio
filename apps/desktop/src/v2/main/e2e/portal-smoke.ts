import { rm } from "node:fs/promises";

import type { BrowserWindow } from "electron";

import { startPortalFixture, type PortalFixture } from "./portal-fixture";

interface SmokeCheck {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: unknown;
}

interface PortalSmokeApi {
  readonly workspace: {
    create(input: { name: string; workingDirectory: string }): Promise<{ id: string }>;
    delete(input: { workspaceId: string }): Promise<unknown>;
  };
  readonly nodes: {
    addPortal(input: {
      workspaceId: string;
      url?: string;
      position?: { x: number; y: number };
    }): Promise<{ id: string; nodes: readonly PortalSmokeNode[] }>;
    move(input: {
      workspaceId: string;
      nodeId: string;
      position: { x: number; y: number };
    }): Promise<{ nodes: readonly PortalSmokeNode[] }>;
    resize(input: {
      workspaceId: string;
      nodeId: string;
      size: { width: number; height: number };
    }): Promise<{ nodes: readonly PortalSmokeNode[] }>;
    delete(input: { workspaceId: string; nodeId: string }): Promise<{
      nodes: readonly PortalSmokeNode[];
    }>;
  };
  readonly portals: {
    ensure(input: { workspaceId: string; portalId: string }): Promise<unknown>;
    setBounds(input: {
      workspaceId: string;
      portalId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      visible: boolean;
    }): Promise<void>;
    navigate(input: { workspaceId: string; portalId: string; url: string }): Promise<unknown>;
    state(input: {
      workspaceId: string;
      portalId?: string;
    }): Promise<readonly PortalSmokeSnapshot[]>;
    focus(input: { workspaceId: string; portalId?: string }): Promise<{ released: number }>;
    resetFocus(input: { workspaceId?: string }): Promise<{ released: number }>;
    surface(input: {
      workspaceId?: string;
      overlays?: readonly string[];
      canvasViewport?: { x: number; y: number; width: number; height: number };
    }): Promise<void>;
    diagnostics(): Promise<Record<string, number>>;
  };
}

interface PortalSmokeNode {
  readonly id: string;
  readonly type: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
}

interface PortalSmokeSnapshot {
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly focused: boolean;
  readonly surface: {
    readonly attached: boolean;
    readonly visible: boolean;
    readonly reason: string;
  };
}

/**
 * Electron smoke dedicated to Portals. It crosses renderer → preload → IPC → native runtime, which
 * is the only place where "the Command Palette is above the Portal" and "Esc gives the canvas back
 * the keyboard" can be proven: a WebContentsView ignores CSS stacking entirely.
 */
export async function runPortalElectronSmoke(window: BrowserWindow): Promise<void> {
  const workingDirectory = requiredEnvironment("COMPAZIO_V2_PORTAL_SMOKE_WORKSPACE");
  let fixture: PortalFixture | undefined;
  try {
    fixture = await startPortalFixture();
    window.show();
    await waitForRenderer(window);
    const result: unknown = await window.webContents.executeJavaScript(
      `(${portalScenario.toString()})(${JSON.stringify({
        workingDirectory,
        baseUrl: fixture.baseUrl
      })})`,
      true
    );
    const checks = Array.isArray(result) ? (result as SmokeCheck[]) : [];
    if (checks.length === 0) throw new Error("Portal smoke returned no checks");
    for (const check of checks)
      console.info(`${check.ok ? "ok  " : "FAIL"} ${check.step} ${JSON.stringify(check.detail)}`);
    const failures = checks.filter((check) => !check.ok);
    if (failures.length > 0)
      throw new Error(`Portal Electron smoke falhou: ${JSON.stringify(failures, null, 2)}`);
    console.info(`Portal Electron smoke: ${checks.length}/${checks.length} verificações`);
  } finally {
    await fixture?.close().catch(() => undefined);
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Serialized into the renderer: it may only use `window`, never a main-process import. */
async function portalScenario(input: {
  workingDirectory: string;
  baseUrl: string;
}): Promise<SmokeCheck[]> {
  const api = (window as unknown as { compazioV2: PortalSmokeApi }).compazioV2;
  const checks: SmokeCheck[] = [];
  const record = (step: string, ok: boolean, detail: unknown = null): void => {
    checks.push({ step, ok, detail });
  };
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const workspace = await api.workspace.create({
    name: "Portais smoke",
    workingDirectory: input.workingDirectory
  });

  // 4. A Portal is added where the canvas was clicked.
  const clicked = { x: 333, y: 214 };
  const withPortal = await api.nodes.addPortal({
    workspaceId: workspace.id,
    url: input.baseUrl,
    position: clicked
  });
  const portal = [...withPortal.nodes].reverse().find((node) => node.type === "portal");
  if (portal === undefined) throw new Error("portal node missing");
  record(
    "Portal adicionado na posição clicada",
    portal.position.x === clicked.x && portal.position.y === clicked.y,
    portal.position
  );

  await api.portals.surface({
    workspaceId: workspace.id,
    canvasViewport: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
  });
  await api.portals.setBounds({
    workspaceId: workspace.id,
    portalId: portal.id,
    x: 40,
    y: 90,
    width: 800,
    height: 520,
    visible: true
  });

  // 5. Navigation reaches the local fixture.
  await api.portals.navigate({
    workspaceId: workspace.id,
    portalId: portal.id,
    url: input.baseUrl
  });
  const opened = (await api.portals.state({ workspaceId: workspace.id, portalId: portal.id }))[0];
  record("Portal navegou para a fixture", opened?.title === "Portal fixture", opened?.title);

  // 6-7. Moving and resizing the node keeps the surface following it.
  const moved = await api.nodes.move({
    workspaceId: workspace.id,
    nodeId: portal.id,
    position: { x: 480, y: 260 }
  });
  const resized = await api.nodes.resize({
    workspaceId: workspace.id,
    nodeId: portal.id,
    size: { width: 640, height: 420 }
  });
  const movedNode = moved.nodes.find((node) => node.id === portal.id);
  const resizedNode = resized.nodes.find((node) => node.id === portal.id);
  record(
    "mover e redimensionar preservam o nó",
    movedNode?.position.x === 480 && resizedNode?.size.width === 640,
    { position: movedNode?.position, size: resizedNode?.size }
  );

  // 10-13. A React surface above the Portal hides it, and closing it brings the Portal back.
  await api.portals.surface({ workspaceId: workspace.id, overlays: ["command-palette"] });
  const covered = (await api.portals.state({ workspaceId: workspace.id, portalId: portal.id }))[0];
  await api.portals.surface({ workspaceId: workspace.id, overlays: [] });
  const restored = (await api.portals.state({ workspaceId: workspace.id, portalId: portal.id }))[0];
  record(
    "Command Palette cobre o Portal e fechá-la restaura",
    covered?.surface.visible === false &&
      covered.surface.attached &&
      covered.surface.reason === "overlay" &&
      restored?.surface.visible === true,
    { covered: covered?.surface, restored: restored?.surface }
  );

  // 14-17. Focus goes to the page and comes back to the canvas.
  await api.portals.focus({ workspaceId: workspace.id, portalId: portal.id });
  const focused = (await api.portals.state({ workspaceId: workspace.id, portalId: portal.id }))[0];
  const released = await api.portals.resetFocus({ workspaceId: workspace.id });
  const afterReset = (
    await api.portals.state({ workspaceId: workspace.id, portalId: portal.id })
  )[0];
  record(
    "focar o Portal e Resetar Foco devolvem o teclado ao canvas",
    focused?.focused === true && released.released === 1 && afterReset?.focused === false,
    { released }
  );

  // 31-32. Replaying the canvas description must not create a second View.
  await api.portals.ensure({ workspaceId: workspace.id, portalId: portal.id });
  await api.portals.ensure({ workspaceId: workspace.id, portalId: portal.id });
  const diagnostics = await api.portals.diagnostics();
  record(
    "recarregar a descrição não duplica a View",
    diagnostics.views === 1 && diagnostics.attachedViews === 1 && diagnostics.webContents === 1,
    diagnostics
  );

  // 35-37. Deleting the Portal removes the node and every resource it owned.
  const deleted = await api.nodes.delete({ workspaceId: workspace.id, nodeId: portal.id });
  await wait(200);
  const afterDelete = await api.portals.diagnostics();
  record(
    "excluir o Portal limpa nó, View, listeners e operações",
    deleted.nodes.every((node) => node.id !== portal.id) &&
      afterDelete.views === 0 &&
      afterDelete.webContents === 0 &&
      afterDelete.listeners === 0 &&
      afterDelete.pendingOperations === 0 &&
      afterDelete.screenshots === 0,
    afterDelete
  );

  // 38-40. Closing the workspace leaves nothing behind.
  await api.workspace.delete({ workspaceId: workspace.id });
  await wait(200);
  const finalDiagnostics = await api.portals.diagnostics();
  record(
    "fechar o workspace não deixa recurso órfão",
    finalDiagnostics.views === 0 &&
      finalDiagnostics.listeners === 0 &&
      finalDiagnostics.consoleEntries === 0,
    finalDiagnostics
  );
  return checks;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function waitForRenderer(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve) => window.webContents.once("did-finish-load", () => resolve()));
}
