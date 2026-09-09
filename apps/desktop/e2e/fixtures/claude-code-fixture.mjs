#!/usr/bin/env node
// Controlled test double for the Claude Code CLI. It is NEVER imported by production code and never
// calls the real Claude — it deterministically simulates a single-shot agent so the adapter path can
// be exercised end to end by swapping only the executable.
//
// Like the real `claude -p`, it reads its prompt EXCLUSIVELY from stdin. There is no file or argv
// fallback for the prompt: if stdin never arrives the fixture fails loudly, so a broken stdin path can
// never pass as a false green. It writes its structured result to COMPAZIO_RESULT_PATH and reports a
// version for `--version`. The scenario is chosen by a `#fixture:<mode>[:<param>]` token in the prompt.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("claude-code-fixture 0.0.1\n");
  process.exit(0);
}

const DIRECTIVE = /#fixture:([a-z-]+)(?::([^\s\]]+))?/;
const resultPath = process.env.COMPAZIO_RESULT_PATH;
let child = null;
let stdinBuffer = "";

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// The prompt arrives on stdin only, exactly like `claude -p`. We read to EOF, then act.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
});
process.stdin.on("end", act);
process.stdin.on("error", () => failLoudly("stdin errored before delivering a prompt"));

// If stdin never closes, fail loudly rather than fall back to any other channel. With a real pipe the
// prompt is delivered and closed immediately, so reaching this is a genuine stdin-delivery failure.
const safety = setTimeout(
  () => failLoudly("no prompt was received on stdin before the deadline"),
  5_000
);
safety.unref?.();

function act() {
  clearTimeout(safety);
  const match = stdinBuffer.match(DIRECTIVE);
  if (match === null) {
    failLoudly("stdin closed without a #fixture directive");
    return;
  }
  run(match[1], match[2]);
}

function failLoudly(reason) {
  process.stderr.write(`fixture: ${reason}\n`);
  process.exit(3);
}

function run(mode, param) {
  switch (mode) {
    case "success":
      writeResult({ status: "ok", mode });
      process.exit(0);
      break;
    case "stdin-echo":
      // Explicit stdin-confirmation mode: proves the exact prompt bytes arrived on stdin, then exits.
      writeResult({
        status: "ok",
        mode,
        receivedBytes: Buffer.byteLength(stdinBuffer, "utf8"),
        sha256: createHash("sha256").update(stdinBuffer, "utf8").digest("hex")
      });
      process.exit(0);
      break;
    case "protocol-path": {
      // Proves the managed evidence path is usable straight from the PROMPT. This mode deliberately
      // never reads COMPAZIO_RESULT_PATH and never runs a shell, exactly like a
      // `--print --permission-mode acceptEdits` session that has no approved way to resolve an
      // environment variable: it writes the project file the objective asked for, and the evidence
      // file at the literal JSON-encoded path the adapter's protocol put in the prompt.
      const encoded = stdinBuffer
        .split(/\r?\n/)
        .find((entry) => entry.startsWith('"') && entry.endsWith('"'));
      if (encoded === undefined) {
        failLoudly("the prompt did not carry the managed evidence path as a JSON string");
        return;
      }
      let managedPath;
      try {
        managedPath = JSON.parse(encoded);
      } catch {
        failLoudly("the managed evidence path in the prompt was not valid JSON");
        return;
      }
      writeFileSync(param ?? "project.txt", "PROJECT_FILE\n", "utf8");
      writeFileSync(managedPath, `${JSON.stringify({ status: "ok", mode })}\n`, "utf8");
      process.exit(0);
      break;
    }
    case "fail":
      process.stderr.write("fixture intentional failure\n");
      process.exit(parseExit(param));
      break;
    case "invalid":
      // Exit 0 without ever producing the declared structured result.
      process.exit(0);
      break;
    case "empty":
      writeRaw("");
      process.exit(0);
      break;
    case "textonly":
      // Prints completion words but never writes the structured result: must NOT count as success.
      process.stdout.write("success\ncompleted\ndone\nfinished\n");
      process.exit(0);
      break;
    case "child":
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      process.stdout.write(`CHILD_PID:${child.pid ?? "unknown"}\n`);
      writeResult({ status: "ok", mode, childPid: child.pid ?? null });
      // Hang so a cancel can prove the whole process tree is terminated.
      keepAlive();
      break;
    case "hang":
      keepAlive();
      break;
    case "orchestrator":
      // Automatic mode asks this same adapter two structurally different questions. They are told apart by
      // the shape of the prompt, never by guessing: a remediation request always states the unmet criteria.
      // The plan's node prompt carries `#fixture:fail` so the first attempt fails for real, and the
      // remediation's corrected prompt carries `#fixture:success` so the retry passes. The JSON goes to
      // STDOUT, because that is where the orchestrator port reads a structured answer from.
      if (stdinBuffer.includes("Unmet acceptance criteria")) {
        process.stdout.write(
          `${JSON.stringify({
            action: "retry_node",
            targetNodeId: "build",
            reason: "The build step failed; retry it with a corrected prompt.",
            updatedPrompt: "Build the thing correctly this time. #fixture:success"
          })}\n`
        );
      } else {
        process.stdout.write(
          `${JSON.stringify({
            title: "Automatic smoke flow",
            summary: "Build the thing, failing once, then verify it.",
            nodes: [
              {
                id: "build",
                title: "Build",
                role: "implementer",
                adapter: "claude-code",
                prompt: "Build the thing. #fixture:fail",
                acceptanceCriteria: ["The build succeeds"],
                operationRisk: "safe"
              }
            ],
            assumptions: [],
            needsHumanApproval: false
          })}\n`
        );
      }
      process.exit(0);
      break;
    default:
      writeResult({ status: "ok", mode: "success" });
      process.exit(0);
  }
}

function keepAlive() {
  setInterval(() => process.uptime(), 1_000);
}

function writeResult(object) {
  writeRaw(`${JSON.stringify(object)}\n`);
}

function writeRaw(text) {
  if (resultPath === undefined) return;
  try {
    writeFileSync(resultPath, text, "utf8");
  } catch {
    // A write failure surfaces as a missing structured result, which the executor treats as failure.
  }
}

function parseExit(param) {
  const parsed = Number.parseInt(param ?? "17", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 17;
}

function stop() {
  if (child !== null) child.kill();
  process.exit(0);
}
