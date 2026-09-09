import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

import { bundledMainWorkspacePackages, nativeRuntimeDependencies } from "./electron.vite.config";

/**
 * Isolated build for the Electron workflow smoke. It emits to `out-e2e`, which electron-builder never
 * packages, so the production bundle (`out/main/index.js`) stays a single, smoke-free entry. The main
 * composition root is built here; the renderer overlay harness is a separate page reachable only from
 * this config (never from the production `index.html`), so no smoke code leaks into production. The
 * smoke reuses the production preload.
 */
export default defineConfig({
  main: {
    build: {
      outDir: "out-e2e/main",
      rollupOptions: {
        external: [...nativeRuntimeDependencies],
        input: { "e2e/workflow-smoke": resolve("src/main/e2e/workflow-smoke.main.ts") }
      }
    },
    plugins: [
      externalizeDepsPlugin({
        exclude: [...bundledMainWorkspacePackages]
      })
    ]
  },
  renderer: {
    root: resolve("src/renderer/e2e"),
    build: {
      outDir: resolve("out-e2e/renderer"),
      emptyOutDir: true,
      rollupOptions: {
        input: resolve("src/renderer/e2e/workflow-overlay-harness.html")
      }
    },
    plugins: [react()]
  }
});
