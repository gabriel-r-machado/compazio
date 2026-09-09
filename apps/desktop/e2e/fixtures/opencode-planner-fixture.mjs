#!/usr/bin/env node
// Controlled test double for the OpenCode CLI acting as a PLANNER. It is NEVER imported by production
// code, is excluded from the shipped bundle, and never calls the real OpenCode — it deterministically
// simulates `opencode run` in planning mode so the OpenCodeOrchestratorPort can be exercised end to
// end by swapping only the executable.
//
// It speaks the REAL protocol the port targets, so a change that breaks the contract fails here
// instead of failing later against the installed CLI:
//   * `--version` reports a version and exits 0;
//   * `run` is required;
//   * NO positional message — the prompt arrives exclusively on stdin, exactly as the real CLI behaves
//     when stdin is piped;
//   * the dangerous permission bypass must never be passed;
//   * the plan is written to the LITERAL path the prompt carries, never to stdout. The fixture reads
//     that path from the prompt alone and never from the environment, which is what proves the literal
//     path is usable by an agent that cannot resolve a variable.
//
// The scenario is chosen by a `#planner:<mode>` token in the prompt.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("1.17.7-planner-fixture\n");
  process.exit(0);
}

const DIRECTIVE = /#planner:([a-z-]+)/;

if (argv[0] !== "run") {
  failLoudly(`expected the 'run' subcommand, received: ${argv[0] ?? "(none)"}`);
}
if (argv.includes("--dangerously-skip-permissions")) {
  failLoudly("the planner must not skip OpenCode's permission checks");
}
const positional = argv.slice(1).filter((entry, index, all) => {
  if (entry.startsWith("-")) return false;
  const previous = all[index - 1];
  return previous === undefined || !previous.startsWith("-");
});
if (positional.length > 0) {
  failLoudly(`the prompt must not be passed as an argument; received ${positional.length}`);
}
const workingDirectory = readFlag("--dir");

let child = null;
let stdinBuffer = "";

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
});
process.stdin.on("end", act);
process.stdin.on("error", () => failLoudly("stdin errored before delivering a prompt"));

const safety = setTimeout(
  () => failLoudly("no prompt was received on stdin before the deadline"),
  5_000
);
safety.unref?.();

/** The managed destination, taken from the PROMPT: a JSON-encoded absolute path on its own line. */
let planPath = null;

function act() {
  clearTimeout(safety);
  const encoded = stdinBuffer
    .split(/\r?\n/)
    .find((line) => line.startsWith('"') && line.endsWith('"') && line.length > 2);
  if (encoded === undefined) {
    failLoudly("the prompt did not carry the managed plan path as a JSON string");
    return;
  }
  try {
    planPath = JSON.parse(encoded);
  } catch {
    failLoudly("the managed plan path in the prompt was not valid JSON");
    return;
  }
  const match = stdinBuffer.match(DIRECTIVE);
  if (match === null) {
    failLoudly("stdin closed without a #planner directive");
    return;
  }
  run(match[1]);
}

function readFlag(name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function failLoudly(reason) {
  process.stderr.write(`opencode-planner-fixture: ${reason}\n`);
  process.exit(3);
}

/** A schema-valid plan that spreads the work across all three executors. */
function validPlan(overrides = {}) {
  return {
    title: "Deliver the slice",
    summary: "Design it, build it, verify it.",
    nodes: [
      node("architecture", "Design the slice", "designer", "claude-code"),
      {
        ...node("implementation", "Build the slice", "implementer", "opencode"),
        dependsOn: ["architecture"]
      },
      { ...node("tests", "Verify the slice", "qa", "codex"), dependsOn: ["implementation"] }
    ],
    assumptions: [],
    needsHumanApproval: false,
    ...overrides
  };
}

function node(id, title, role, adapter) {
  return { id, title, role, adapter, prompt: `${title}. Answer with the work only.` };
}

function run(mode) {
  switch (mode) {
    case "valid":
      writePlan(validPlan());
      break;
    case "smoke":
      // The plan the Electron smoke executes: three nodes, three different executors, and prompts the
      // official executor fixtures understand. The planner still only PLANS — it runs nothing.
      writePlan({
        title: "Deliver the slice",
        summary: "Design it, build it, verify it.",
        nodes: [
          {
            id: "ux",
            title: "Design the UX #fixture:success",
            role: "designer",
            adapter: "claude-code",
            prompt: "Design the UX. #fixture:success",
            dependsOn: []
          },
          {
            id: "implementation",
            title: "Build it #fixture:consume",
            role: "implementer",
            adapter: "opencode",
            prompt: "Build it. #fixture:consume",
            dependsOn: ["ux"]
          },
          {
            id: "tests",
            title: "Verify it #fixture:consume",
            role: "qa",
            adapter: "codex",
            prompt: "Verify it. #fixture:consume",
            dependsOn: ["implementation"]
          }
        ],
        assumptions: [],
        needsHumanApproval: false
      });
      break;
    case "unicode":
      writePlan(
        validPlan({
          title: "Entrega da fatia — 日本語 ✅",
          summary: "Projetar, construir e verificar. Ünïcödé preservado."
        })
      );
      break;
    case "invalid-json":
      writeRaw(planPath, '{"title": "broken", "nodes": [');
      break;
    case "markdown":
      // Valid JSON, but fenced. The port must REPORT this, never quietly unwrap it.
      writeRaw(planPath, `\`\`\`json\n${JSON.stringify(validPlan(), null, 2)}\n\`\`\`\n`);
      break;
    case "missing-field": {
      const plan = validPlan();
      delete plan.nodes[0].prompt;
      writePlan(plan);
      break;
    }
    case "invalid-role": {
      const plan = validPlan();
      plan.nodes[0].role = "wizard";
      writePlan(plan);
      break;
    }
    case "invalid-adapter": {
      const plan = validPlan();
      plan.nodes[0].adapter = "ghost-agent";
      writePlan(plan);
      break;
    }
    case "missing-dependency": {
      const plan = validPlan();
      plan.nodes[1].dependsOn = ["does-not-exist"];
      writePlan(plan);
      break;
    }
    case "cycle": {
      const plan = validPlan();
      plan.nodes[0].dependsOn = ["tests"];
      writePlan(plan);
      break;
    }
    case "limit": {
      const plan = validPlan();
      plan.nodes = Array.from({ length: 12 }, (_, index) =>
        node(`node-${index}`, `Step ${index}`, "implementer", "opencode")
      );
      writePlan(plan);
      break;
    }
    case "empty":
      writeRaw(planPath, "");
      break;
    case "no-file":
      // Exits 0 having written nothing at all.
      process.exit(0);
      break;
    case "stdout-only":
      // Prints a perfectly valid plan to stdout and writes no file: stdout is NOT authority.
      process.stdout.write(`${JSON.stringify(validPlan())}\n`);
      process.exit(0);
      break;
    case "huge": {
      const plan = validPlan();
      plan.summary = "x".repeat(600 * 1024);
      writeRaw(planPath, JSON.stringify(plan));
      break;
    }
    case "mutate-snapshot":
      // Writes inside its own disposable snapshot, then answers correctly. The snapshot absorbs it;
      // the real workspace must still be untouched.
      writeRaw(join(workingDirectory ?? ".", "planner-touched-the-snapshot.txt"), "written\n");
      writePlan(validPlan());
      break;
    case "escape-workspace": {
      // Tries to reach a path outside its snapshot. The attempt is recorded in the plan's summary so a
      // test can assert it FAILED, and the real workspace fingerprint proves nothing changed.
      const forbidden = process.env.COMPAZIO_FORBIDDEN_PATH;
      let escaped = false;
      if (forbidden !== undefined) {
        try {
          writeFileSync(forbidden, "escaped\n", "utf8");
          escaped = true;
        } catch {
          escaped = false;
        }
      }
      writePlan(validPlan({ summary: `Escape attempt succeeded: ${String(escaped)}` }));
      break;
    }
    case "child":
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      process.stdout.write(`CHILD_PID:${child.pid ?? "unknown"}\n`);
      keepAlive();
      break;
    case "hang":
      keepAlive();
      break;
    default:
      writePlan(validPlan());
  }
}

function keepAlive() {
  setInterval(() => process.uptime(), 1_000);
}

function writePlan(plan) {
  writeRaw(planPath, `${JSON.stringify(plan)}\n`);
  process.exit(0);
}

function writeRaw(path, text) {
  if (path === undefined || path === null) return;
  try {
    writeFileSync(path, text, "utf8");
  } catch {
    // A write failure surfaces as a missing plan, which the port treats as a planning failure.
  }
  if (path === planPath) process.exit(0);
}

function stop() {
  if (child !== null) child.kill();
  process.exit(0);
}
