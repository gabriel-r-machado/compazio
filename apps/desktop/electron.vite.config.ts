import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export const nativeRuntimeDependencies = ["better-sqlite3", "node-pty"] as const;

/** Workspace packages bundled into the Electron main process (not externalized). */
export const bundledMainWorkspacePackages = [
  "@forgedeck/agent-adapters",
  "@forgedeck/cli",
  "@forgedeck/config",
  "@forgedeck/core",
  "@forgedeck/git",
  "@forgedeck/local-db",
  "@forgedeck/logger",
  "@forgedeck/orchestration",
  "@forgedeck/schemas",
  "@forgedeck/terminal",
  "@forgedeck/workflow"
] as const;

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Two entries share the main bundle's module graph and externals: the Electron main process,
        // and the `compazio` CLI an agent reaches from its terminal. The CLI runs under
        // `ELECTRON_RUN_AS_NODE`, so it needs exactly the same native-module treatment.
        input: {
          index: resolve("src/main/index.ts"),
          "compazio-cli": resolve("src/main/compazio-cli-entry.ts")
        },
        external: [...nativeRuntimeDependencies]
      }
    },
    plugins: [
      externalizeDepsPlugin({
        exclude: [...bundledMainWorkspacePackages]
      })
    ]
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          entryFileNames: "[name].cjs",
          format: "cjs"
        }
      }
    },
    plugins: [
      externalizeDepsPlugin({
        // Sandboxed preloads cannot resolve workspace or package dependencies from the runtime
        // filesystem. Keep every schema validator used by the typed bridge in the preload bundle.
        exclude: ["@forgedeck/schemas", "@forgedeck/workflow", "zod"]
      })
    ]
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()]
  }
});
