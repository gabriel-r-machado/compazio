import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"]
    },
    include: [
      "apps/**/*.test.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
      "scripts/**/*.test.{ts,tsx}"
    ],
    exclude: ["**/*.integration.test.{ts,tsx}", "**/node_modules/**", "**/.git/**"],
    passWithNoTests: false
  }
});
