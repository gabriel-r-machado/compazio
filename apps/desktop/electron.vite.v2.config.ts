import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

import { bundledMainWorkspacePackages, nativeRuntimeDependencies } from "./electron.vite.config";

const bundledMainPackages = [
  ...bundledMainWorkspacePackages,
  "@forgedeck/compazio-v2-domain",
  "@forgedeck/compazio-v2-persistence",
  "@forgedeck/compazio-v2-runtime",
  "@forgedeck/terminal"
];

/** Isolated V2 entrypoint. It deliberately leaves the legacy `electron.vite.config.ts` untouched. */
export default defineConfig({
  main: {
    build: {
      outDir: "out-v2/main",
      rollupOptions: {
        input: { index: resolve("src/v2/main/index.ts") },
        external: [...nativeRuntimeDependencies]
      }
    },
    plugins: [externalizeDepsPlugin({ exclude: bundledMainPackages })]
  },
  preload: {
    build: {
      outDir: "out-v2/preload",
      rollupOptions: {
        input: { index: resolve("src/v2/preload/index.ts") },
        output: { entryFileNames: "[name].cjs", format: "cjs" }
      }
    },
    // The sandboxed preload cannot resolve arbitrary package dependencies at runtime. `zod` is
    // used by the shared V2 IPC schemas, so it must be bundled with that isolated context.
    plugins: [externalizeDepsPlugin({ exclude: ["@forgedeck/compazio-v2-domain", "zod"] })]
  },
  renderer: {
    root: resolve("src/v2/renderer"),
    build: {
      outDir: resolve("out-v2/renderer"),
      emptyOutDir: true,
      rollupOptions: { input: resolve("src/v2/renderer/index.html") }
    },
    plugins: [react()]
  }
});
