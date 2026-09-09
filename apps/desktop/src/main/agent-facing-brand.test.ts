import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ORCHESTRATOR_GLOBAL_LIMITS,
  ORCHESTRATOR_TEAM_PERMISSIONS,
  buildOrchestratorTeamInstructions,
  buildWorkerPrompt
} from "@forgedeck/orchestration";
import { spawnAgentAdapterIdSchema, workflowNodeDraftSchema } from "@forgedeck/schemas";
import { describe, expect, it } from "vitest";

import { buildTerminalContextPrompt } from "./terminal-context-staging";
import type { StagedTerminalContext } from "./terminal-context-staging";

/**
 * The product is Compazio, and no other canvas product's name may reach an agent or ship inside the
 * app. This is not cosmetic: a rival pack named on the wire teaches the agent to reach for a surface
 * this desktop does not own, and the user watches their own product introduce itself as someone
 * else's. It happened once through a foreign team-management skill the runtime picked up from the
 * host machine, so the guard covers both halves of the exposure.
 *
 * The runtime half asserts on text this process actually assembles and types into a PTY. The static
 * half walks the surface that ships or is read at runtime — sources, prompts, schemas, packaged
 * migrations, and the agent-facing config directories. Note bodies and role text are excluded by
 * construction: those are the user's own words, and the product does not police what a user writes
 * on their own canvas.
 *
 * `docs/` and the root design notes are deliberately out of scope. Naming the products we studied is
 * legitimate there, and none of it is packaged or sent anywhere.
 */

/** Names that must never appear in product-generated agent-facing or distributed content. */
const FORBIDDEN_BRANDS = [
  new RegExp(String.fromCharCode(109, 97, 101, 115, 116, 114, 105), "i"),
  new RegExp(String.fromCharCode(109, 97, 101, 115, 116, 114, 111), "i")
];

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** Roots that either ship inside the app or are read while a session runs. */
const SCANNED_ROOTS = ["apps", "packages", "prompts", "specs", ".claude", ".agents", ".opencode"];

const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".sql",
  ".yml",
  ".yaml",
  ".txt",
  ".sh",
  ".ps1",
  ".cmd"
]);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "out",
  "out-v2",
  "out-e2e",
  "build",
  "release",
  "coverage",
  "artifacts",
  ".turbo",
  ".git",
  // Local git worktrees: developer scratch checkouts of this same repo, never packaged.
  "worktrees"
]);

/** This file names the brands it forbids, so it cannot be subject to its own scan. */
const guardFile = relative(repoRoot, fileURLToPath(import.meta.url))
  .split(sep)
  .join("/");

function scannableFiles(): readonly string[] {
  const found: string[] = [];

  const walk = (absolute: string): void => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return; // An optional root (.agents, .opencode) simply does not exist here.
    }
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(child);
        }
        continue;
      }
      if (!entry.isFile() || !SCANNED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        continue;
      }
      const path = relative(repoRoot, child).split(sep).join("/");
      if (path !== guardFile) {
        found.push(path);
      }
    }
  };

  for (const root of SCANNED_ROOTS) {
    walk(join(repoRoot, root));
  }
  return found;
}

const scannedFiles = scannableFiles();

function staged(overrides: Partial<StagedTerminalContext> = {}): StagedTerminalContext {
  return {
    ok: true,
    sessionId: "session-1",
    nodeId: "orchestrator-1",
    mission: "Montar um time e entregar a landing page",
    permissions: ORCHESTRATOR_TEAM_PERMISSIONS,
    role: {
      name: "Coordenador",
      responsibilities: "Dividir o trabalho e acompanhar a entrega",
      constraints: "Não implementar sozinho",
      expectedDeliverable: "Landing page publicada",
      completionCriteria: "Time respondeu e o build passou"
    },
    notes: [{ nodeId: "note-1", title: "Briefing", content: "Use o design aprovado." }],
    links: [{ nodeId: "link-1", title: "Referência", url: "https://example.com" }],
    attachments: [],
    inputsDirectory: "C:/projeto/.compazio/runs/session-1/inputs",
    manifestPath: "C:/projeto/.compazio/runs/session-1/context-manifest.json",
    ...overrides
  };
}

describe("no foreign canvas brand reaches an agent", () => {
  it("keeps the terminal bootstrap prompt free of any other product's name", () => {
    const prompt = buildTerminalContextPrompt(staged());

    // The team surface only ships for a node that holds it; assert we are checking the loaded case.
    expect(prompt).toContain("compazio terminal create");
    for (const brand of FORBIDDEN_BRANDS) {
      expect(prompt).not.toMatch(brand);
    }
  });

  it("keeps the injected team surface free of any other product's name", () => {
    const instructions = buildOrchestratorTeamInstructions({
      selfNodeId: "orchestrator-1",
      usableRuntimeIds: [...spawnAgentAdapterIdSchema.options],
      maxSpawnedAgents: ORCHESTRATOR_GLOBAL_LIMITS.maxSpawnedAgents,
      maxConcurrentAgents: ORCHESTRATOR_GLOBAL_LIMITS.maxConcurrentAgents
    });

    for (const brand of FORBIDDEN_BRANDS) {
      expect(instructions).not.toMatch(brand);
    }
  });

  it("keeps a dispatched worker's contract free of any other product's name", () => {
    const prompt = buildWorkerPrompt({
      node: workflowNodeDraftSchema.parse({
        id: "fe",
        title: "Front-end",
        role: "implementer",
        objective: "Implementar as seções responsivas",
        acceptanceCriteria: ["Responsivo"]
      }),
      taskId: "fe",
      dispatchId: "d1",
      objective: "landing page premium"
    });

    for (const brand of FORBIDDEN_BRANDS) {
      expect(prompt).not.toMatch(brand);
    }
  });
});

describe("no foreign canvas brand ships with the product", () => {
  it("scans a surface that actually covers prompts, skills, templates and agent config", () => {
    const files = scannedFiles;

    // A silent miss here would make every assertion below vacuous.
    expect(files).toContain("packages/orchestration/src/orchestrator-team-instructions.ts");
    expect(files).toContain("apps/desktop/src/main/terminal-context-staging.ts");
    expect(files).toContain("packages/local-db/drizzle/meta/_journal.json");
    expect(files.length).toBeGreaterThan(500);
  });

  it("finds no other product's name in any distributed or runtime file", () => {
    const offenders = scannedFiles.filter((path) => {
      const contents = readFileSync(join(repoRoot, path), "utf8");
      return FORBIDDEN_BRANDS.some((brand) => brand.test(contents));
    });

    expect(offenders).toEqual([]);
  }, 20_000);
});
