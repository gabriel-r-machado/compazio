import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("./app.tsx", import.meta.url)), "utf8");
const files = readFileSync(fileURLToPath(new URL("./file-ui.tsx", import.meta.url)), "utf8");
const composer = readFileSync(
  fileURLToPath(new URL("./prompt-composer.tsx", import.meta.url)),
  "utf8"
);
const operational = readFileSync(
  fileURLToPath(new URL("./operational-ui.tsx", import.meta.url)),
  "utf8"
);

describe("V2 beta interface contract", () => {
  it("keeps the visual system centralized and accessible", () => {
    expect(css).toContain("--v2-bg");
    expect(css).toContain("--v2-accent");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("focus-visible");
    expect(css).toContain("@media (max-width: 1180px)");
    expect(css).toContain("@media (max-width: 900px)");
  });

  it("carries the Compazio identity in tokens instead of ad-hoc values", () => {
    expect(css).toContain("--brand-black: #0a0a0a");
    expect(css).toContain("--brand-graphite: #1a1a1a");
    expect(css).toContain("--brand-gray: #6c6c6c");
    expect(css).toContain("--brand-light: #e5e5e5");
    expect(css).toMatch(/--v2-font-brand:\s*"Manrope Variable"/);
    expect(css).toMatch(/--v2-font-ui:\s*\n?\s*"Inter Variable"/);
    expect(css).toMatch(/--v2-font-mono:\s*"JetBrains Mono Variable"/);
    // As fontes vêm empacotadas: a identidade não pode depender de rede nem do que o Windows tem.
    expect(css).toContain('@import "@fontsource-variable/manrope"');
    expect(css).toContain('@import "@fontsource-variable/inter"');
    expect(css).toContain('@import "@fontsource-variable/jetbrains-mono"');
  });

  it("never exposes legacy coordinator names in a public interface or injected prompt surface", () => {
    const publicSurface = [app, files, composer, operational].join("\n");
    expect(publicSurface).not.toMatch(
      new RegExp(String.fromCharCode(109, 97, 101, 115, 116, 114, 111), "i")
    );
    expect(publicSurface).not.toMatch(/compasso/i);
    expect(publicSurface).toContain("ORCHESTRATOR_LABEL");
  });

  it("keeps the first-use path focused on a workspace and canvas", () => {
    expect(app).toContain("WorkspaceCreateDialog");
    expect(app).toContain("v2-agent-readiness");
    expect(app).toContain("v2-canvas-empty-hint");
    expect(app).not.toContain("window.prompt(");
    expect(files).not.toContain("window.prompt(");
    expect(app).toContain("v2-role-editor");
  });

  it("keeps the canvas navigable: pan, marquee, zoom to pointer and minimap", () => {
    expect(app).toContain("startCanvasGesture");
    expect(app).toContain("zoomAtPoint");
    expect(app).toContain("nodesInRect");
    expect(app).toContain("<Minimap");
    expect(app).toContain("spaceHeld");
    expect(css).toContain(".v2-marquee");
    expect(css).toContain(".v2-minimap");
  });

  // A camada do mundo cobre o canvas inteiro: se ela receber ponteiro, o arrasto de fundo morre.
  it("keeps the canvas surface reachable under the transform layer", () => {
    expect(css).toMatch(/\.v2-world\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.v2-world\s*>\s*\.v2-node\s*\{[^}]*pointer-events:\s*auto/);
  });

  it("lets a person wire nodes by dragging from an edge handle", () => {
    expect(app).toContain("startLink");
    expect(app).toContain('data-testid="v2-linking-preview"');
    expect(app).toContain("handleAnchor");
    expect(css).toContain(".v2-node-handle");
    // Durante o arrasto as alças saem do caminho, senão o nó de destino nunca é encontrado.
    expect(css).toMatch(
      /\.v2-canvas\[data-linking="true"\] \.v2-node-handle \{[^}]*pointer-events:\s*none/
    );
  });

  it("creates a default terminal by click and keeps drawing as an explicit toolbar gesture", () => {
    expect(app).toContain('data-testid="v2-add-terminal"');
    expect(app).toContain('data-testid="v2-draw-terminal"');
    expect(app).toContain("onClick={() => addTerminal()}");
    expect(css).toContain(".v2-node-draft");
  });

  it("grants team coordination explicitly on a visible coding-agent terminal", () => {
    expect(app).toContain("Este agente coordena o time");
    expect(app).toContain('data-testid="v2-terminal-coordinator"');
    expect(app).toContain("isCompazio: canCoordinate && isCompazio");
    expect(app).toContain('data-testid="v2-team-coordinator"');
  });

  it("keeps the terminal chrome inside the node instead of scrolling sideways", () => {
    expect(css).toMatch(/\.v2-terminal-controls \{[^}]*grid-template-columns/);
    expect(css).not.toMatch(/\.v2-terminal-controls \{[^}]*overflow-x:\s*auto/);
    expect(css).toContain(".v2-terminal-badges");
    // Redimensionar tem alça própria: o canto nativo fica inalcançável atrás do conteúdo.
    expect(css).toContain(".v2-node-resize");
    expect(app).toContain('data-testid="v2-node-resize"');
  });

  it("brings files in through the system picker and through a drop", () => {
    expect(app).toContain("window.compazioV2.files.import");
    expect(app).toContain("pathsFromDrop");
    expect(app).toContain('data-testid="v2-import-files"');
  });

  it("reloads Markdown notes when their real files change outside the canvas", () => {
    expect(app).toContain('const notesDirectory = ".compazio/notes"');
    expect(app).toContain("window.compazioV2.files.onEvent");
    expect(app).toContain("treeNodeId: note.id");
  });

  // A superfície nativa do Portal não é recortada por CSS: as medidas têm de vir do próprio card.
  it("keeps the portal surface measured and clipped by the canvas", () => {
    expect(app).toContain('data-testid="v2-portal-surface"');
    expect(app).toContain("canvasZoom");
    expect(app).toMatch(/closest<HTMLElement>\("\.v2-canvas"\)/);
  });

  it("keeps the workspace toolbar quiet and moves the rest behind one menu", () => {
    expect(app).toContain('className="v2-dock"');
    expect(app).toContain('data-testid="v2-more-menu"');
    expect(app).toContain("const LEGACY_TEAM_RUNTIME_UI_ENABLED = false");
    expect(app).toContain("{LEGACY_TEAM_RUNTIME_UI_ENABLED && (");
    expect(app).not.toContain('id: "action:attention"');
  });
});
