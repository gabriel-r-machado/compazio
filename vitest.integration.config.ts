import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.integration.test.{ts,tsx}", "packages/**/*.integration.test.{ts,tsx}"],
    passWithNoTests: false,
    testTimeout: 15_000,
    // Windows ConPTY associates child terminals with the worker console. Running PTY-backed files
    // in parallel makes node-pty intermittently fail AttachConsole, turning valid integration
    // diagnostics into process failures. Unit tests remain fully parallel; only this real-process
    // integration lane is serialized.
    fileParallelism: false
  }
});
