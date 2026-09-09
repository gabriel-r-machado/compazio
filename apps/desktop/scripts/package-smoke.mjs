import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const executable = process.env.COMPAZIO_V2_PACKAGED_EXECUTABLE;
if (executable === undefined || executable.length === 0)
  throw new Error("COMPAZIO_V2_PACKAGED_EXECUTABLE is required for a packaged smoke test.");
if (!existsSync(executable)) throw new Error(`Packaged application was not found: ${executable}`);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDirectory, "..");

await run(process.execPath, [join(desktopRoot, "scripts", "v2-smoke.mjs")], {
  COMPAZIO_V2_SMOKE_EXECUTABLE: resolve(executable),
  COMPAZIO_V2_PACKAGED_SMOKE: "true",
  COMPAZIO_V2_TERMINAL_ONLY: "true",
  COMPAZIO_V2_UI_SMOKE: "true"
});

process.stdout.write("Packaged Compazio smoke passed.\n");

function run(command, args, extraEnvironment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: desktopRoot,
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env, ...extraEnvironment }
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Packaged Compazio smoke timed out."));
    }, 300_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`Packaged Compazio smoke exited with code ${code ?? "unknown"}.`));
    });
  });
}
