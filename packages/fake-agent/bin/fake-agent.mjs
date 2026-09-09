#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = parseArgs(process.argv.slice(2));
const mode = args.get("mode") ?? "echo";
const markedSecret = "FORGEDECK_TEST_SECRET_runtime-diagnostic";
let child = null;

process.on("SIGTERM", handleStop);
process.on("SIGINT", handleStop);

switch (mode) {
  case "burst": {
    const lines = parsePositiveInteger(args.get("lines"), 1000);
    for (let index = 0; index < lines; index += 1) {
      process.stdout.write(`fake-line-${index}\n`);
    }
    process.exit(0);
    break;
  }
  case "crash": {
    process.stderr.write("fake-agent intentional crash\n");
    process.exit(parsePositiveInteger(args.get("exit-code"), 17));
    break;
  }
  case "slow": {
    const delayMs = parsePositiveInteger(args.get("delay-ms"), 250);
    setTimeout(() => {
      process.stdout.write("slow-complete\n");
      process.exit(0);
    }, delayMs);
    break;
  }
  case "flaky": {
    const stateFile = args.get("state-file");
    if (stateFile === undefined) {
      process.stderr.write("flaky mode requires --state-file\n");
      process.exit(2);
    }
    if (!existsSync(stateFile)) {
      writeFileSync(stateFile, "failed-once", { encoding: "utf8", flag: "wx" });
      process.stderr.write("fake-agent transient failure\n");
      process.exit(17);
    }
    process.stdout.write('{"type":"result","status":"recovered"}\n');
    process.exit(0);
    break;
  }
  case "hang": {
    if (args.has("spawn-child")) {
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore"
      });
      process.stdout.write(`CHILD_PID:${child.pid ?? "unknown"}\n`);
    }
    process.stdout.write("hanging\n");
    setInterval(() => process.uptime(), 1000);
    break;
  }
  case "secret": {
    process.stdout.write(`${markedSecret}\n`);
    process.exit(0);
    break;
  }
  case "echo": {
    process.stdout.write("ready\n");
    const input = createInterface({ input: process.stdin, terminal: false });
    input.on("line", (line) => {
      if (line === "exit") {
        input.close();
        process.exit(0);
      }
      if (line === "size") {
        process.stdout.write(`SIZE:${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0}\n`);
        return;
      }
      if (line === "secret") {
        process.stdout.write(`${markedSecret}\n`);
        return;
      }
      process.stdout.write(`ECHO:${line}\n`);
    });
    break;
  }
  case "plan": {
    // Planner agent: turns an objective into a deterministic structured artifact on disk.
    const out = args.get("out");
    if (out === undefined) {
      process.stderr.write("plan mode requires --out\n");
      process.exit(2);
    }
    // Optional deterministic single failure, so a node-level retry can be proven end to end.
    const failOnce = args.get("fail-once");
    if (failOnce !== undefined && !existsSync(failOnce)) {
      writeFileSync(failOnce, "failed-once", { encoding: "utf8", flag: "wx" });
      process.stderr.write("fake-agent planner transient failure\n");
      process.exit(17);
    }
    const objective = args.get("objective") ?? "unspecified";
    const plan = {
      type: "plan",
      objective,
      steps: ["design", "implement", "verify"],
      producedBy: "fake-agent"
    };
    writeFileSync(out, `${JSON.stringify(plan)}\n`, { encoding: "utf8" });
    process.stdout.write('{"type":"result","status":"planned"}\n');
    process.exit(0);
    break;
  }
  case "build": {
    // Executor agent: only succeeds when it can consume the planner's structured artifact.
    const planPath = args.get("plan");
    const out = args.get("out");
    if (planPath === undefined || out === undefined) {
      process.stderr.write("build mode requires --plan and --out\n");
      process.exit(2);
    }
    if (!existsSync(planPath)) {
      process.stderr.write("build mode could not read the plan artifact\n");
      process.exit(19);
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const build = {
      type: "build",
      basedOnObjective: plan.objective,
      stepsExecuted: plan.steps,
      status: "built"
    };
    writeFileSync(out, `${JSON.stringify(build)}\n`, { encoding: "utf8" });
    process.stdout.write('{"type":"result","status":"built"}\n');
    process.exit(0);
    break;
  }
  default:
    process.stderr.write(`Unknown fake-agent mode: ${mode}\n`);
    process.exit(2);
}

function handleStop() {
  if (args.has("ignore-stop")) {
    process.stdout.write("stop-ignored\n");
    return;
  }
  if (child !== null) {
    child.kill();
  }
  process.stdout.write("stopped\n");
  process.exit(0);
}

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed.set(key, next);
      index += 1;
    } else {
      parsed.set(key, "true");
    }
  }
  return parsed;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
