#!/usr/bin/env node
// Controlled test double for the OpenCode CLI. It is NEVER imported by production code, is excluded
// from the shipped bundle, and never calls the real OpenCode — it deterministically simulates
// `opencode run` so the adapter path can be exercised end to end by swapping only the executable.
//
// It speaks the REAL protocol the adapter targets, so a change that breaks the contract cannot pass
// here and fail in production:
//   * `--version` reports a version and exits 0;
//   * `run` is required — any other invocation fails loudly;
//   * the prompt arrives EXCLUSIVELY on stdin, with NO positional message, exactly as the real CLI
//     behaves when stdin is piped. If stdin never closes the fixture fails rather than falling back
//     to any other channel, so a broken stdin path can never pass as a false green;
//   * the result is written to COMPAZIO_RESULT_PATH, the managed staging path — never to stdout.
//
// The scenario is chosen by a `#fixture:<mode>[:<param>]` token in the prompt.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("1.17.7-fixture\n");
  process.exit(0);
}

const DIRECTIVE = /#fixture:([a-z-]+)(?::([^\s\]]+))?/;

if (argv[0] !== "run") {
  failLoudly(`expected the 'run' subcommand, received: ${argv[0] ?? "(none)"}`);
}
// The real CLI would treat a positional as the message; the adapter must never place the prompt there.
const positional = argv.slice(1).filter((entry, index, all) => {
  if (entry.startsWith("-")) return false;
  const previous = all[index - 1];
  return previous === undefined || !previous.startsWith("-");
});
if (positional.length > 0) {
  failLoudly(`the prompt must not be passed as an argument; received ${positional.length}`);
}
// The dangerous permission bypass must never be used by the adapter.
if (argv.includes("--dangerously-skip-permissions")) {
  failLoudly("the adapter must not skip OpenCode's permission checks");
}

const resultPath = process.env.COMPAZIO_RESULT_PATH;
const workingDirectory = readFlag("--dir");
const model = readFlag("-m") ?? readFlag("--model");
if (resultPath === undefined) {
  failLoudly("the adapter must name a managed result path in COMPAZIO_RESULT_PATH");
}

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

function readFlag(name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function failLoudly(reason) {
  process.stderr.write(`opencode-fixture: ${reason}\n`);
  process.exit(3);
}

function run(mode, param) {
  switch (mode) {
    case "success":
      writeResult(`OpenCode completed the step.\nmode=${mode}\nmodel=${model ?? "default"}\n`);
      process.exit(0);
      break;
    case "stdin-echo":
      // Proves the exact prompt bytes arrived on stdin, unmodified, including Unicode and newlines.
      writeResult(
        `receivedBytes=${Buffer.byteLength(stdinBuffer, "utf8")}\n` +
          `sha256=${createHash("sha256").update(stdinBuffer, "utf8").digest("hex")}\n` +
          `dir=${workingDirectory ?? "unset"}\n`
      );
      process.exit(0);
      break;
    case "consume": {
      // Reads the upstream artifact named in the prompt and verifies its hash, proving the handoff
      // between two different agents travels through Compazio's artifacts rather than shared memory.
      const upstream = /- [^:]+: (.+) \(sha256 ([0-9a-f]{64})/.exec(stdinBuffer);
      if (upstream === null) {
        failLoudly("no upstream artifact reference was present in the prompt");
        return;
      }
      let bytes;
      try {
        bytes = readFileSync(upstream[1]);
      } catch {
        failLoudly("the upstream artifact could not be read at the path given in the prompt");
        return;
      }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== upstream[2]) {
        failLoudly("the upstream artifact did not match the hash recorded in the prompt");
        return;
      }
      writeResult(`consumedSha256=${actual}\nmode=${mode}\n`);
      process.exit(0);
      break;
    }
    case "fail":
      process.stderr.write("opencode-fixture intentional failure\n");
      process.exit(parseExit(param));
      break;
    case "invalid":
      // Exit 0 without ever writing the declared result file.
      process.exit(0);
      break;
    case "empty":
      writeResult("");
      process.exit(0);
      break;
    case "textonly":
      // Prints completion words but never writes the result file: must NOT count as success.
      process.stdout.write("success\ncompleted\ndone\nfinished\n");
      process.exit(0);
      break;
    case "stray":
      // Writes an undeclared file next to the result; only the declared artifact may be published.
      writeRaw(`${resultPath}.stray`, "this file was never declared\n");
      writeResult(`mode=${mode}\n`);
      process.exit(0);
      break;
    case "child":
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      process.stdout.write(`CHILD_PID:${child.pid ?? "unknown"}\n`);
      writeResult(`mode=${mode}\nchildPid=${child.pid ?? "unknown"}\n`);
      // Hang so a cancel can prove the whole process tree is terminated.
      keepAlive();
      break;
    case "hang":
      keepAlive();
      break;
    default:
      writeResult("OpenCode completed the step.\nmode=success\n");
      process.exit(0);
  }
}

function keepAlive() {
  setInterval(() => process.uptime(), 1_000);
}

function writeResult(text) {
  writeRaw(resultPath, text);
}

function writeRaw(path, text) {
  if (path === undefined) return;
  try {
    writeFileSync(path, text, "utf8");
  } catch {
    // A write failure surfaces as a missing result, which the executor treats as a failure.
  }
}

function parseExit(param) {
  const parsed = Number.parseInt(param ?? "23", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 23;
}

function stop() {
  if (child !== null) child.kill();
  process.exit(0);
}
