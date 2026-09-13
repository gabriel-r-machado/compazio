import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDirectory, "..");
if (process.platform !== "win32") throw new Error("The packaged smoke test requires Windows");
const installer = await resolveInstaller();
const temporaryRoot = await mkdtemp(join(tmpdir(), "compazio-nsis-smoke-"));
const installationDirectory = join(temporaryRoot, "Compazio");
const executable = join(installationDirectory, "Compazio.exe");

try {
  await run("NSIS install", installer, ["/S", `/D=${installationDirectory}`]);
  if (!existsSync(executable))
    throw new Error(`Installed Compazio executable was not found: ${executable}`);
  await run(
    "Installed Compazio smoke",
    process.execPath,
    [join(desktopRoot, "scripts", "package-smoke.mjs")],
    {
      COMPAZIO_V2_PACKAGED_EXECUTABLE: executable
    }
  );
  const uninstaller = join(installationDirectory, "Uninstall Compazio Community.exe");
  if (!existsSync(uninstaller)) throw new Error("NSIS uninstaller was not found.");
  await run("NSIS uninstall", uninstaller, ["/S", `_?=${installationDirectory}`]);
  if (existsSync(executable))
    throw new Error("NSIS uninstall left the Compazio executable behind.");
  process.stdout.write("Installed Compazio NSIS smoke passed.\n");
} catch (error) {
  process.stderr.write(
    `Installed Compazio NSIS smoke failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function resolveInstaller() {
  if (process.env.COMPAZIO_V2_PACKAGED_INSTALLER !== undefined) {
    if (!existsSync(process.env.COMPAZIO_V2_PACKAGED_INSTALLER))
      throw new Error(
        `Configured NSIS installer was not found: ${process.env.COMPAZIO_V2_PACKAGED_INSTALLER}`
      );
    return process.env.COMPAZIO_V2_PACKAGED_INSTALLER;
  }
  const releaseDirectory = join(desktopRoot, "release");
  const packageJson = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0)
    throw new Error("Desktop package version is missing.");
  const expectedInstaller = `Compazio-Setup-${packageJson.version}.exe`;
  const candidates = (await readdir(releaseDirectory))
    .filter((name) => name === expectedInstaller)
    .sort();
  if (candidates.length !== 1)
    throw new Error(`Expected NSIS installer was not found: ${expectedInstaller}`);
  return join(releaseDirectory, candidates[0]);
}

function run(label, command, args, extraEnvironment = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: desktopRoot,
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env, ...extraEnvironment }
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} timed out`));
    }, 300_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} exited with code ${code ?? "unknown"}`));
    });
  });
}
