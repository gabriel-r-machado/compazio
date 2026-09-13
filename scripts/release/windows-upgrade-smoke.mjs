import { createWriteStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

if (process.platform !== "win32") throw new Error("The upgrade smoke requires Windows");

const oldVersion = "0.1.0-beta.7";
const expectedVersion = "0.2.0-beta.1";
const newInstaller = resolve(process.argv[2] ?? "");
if (!existsSync(newInstaller)) throw new Error(`Installer not found: ${newInstaller}`);

const temporaryRoot = await mkdtemp(join(tmpdir(), "compazio-upgrade-smoke-"));
const oldInstaller = join(temporaryRoot, `Compazio-Setup-${oldVersion}.exe`);
const installationDirectory = join(temporaryRoot, "Compazio");
const preservedData = join(temporaryRoot, "workspace-preservation.sentinel");
const executable = join(installationDirectory, "Compazio.exe");

try {
  await download(
    `https://github.com/gabriel-r-machado/compazio/releases/download/v${oldVersion}/Compazio-Setup-${oldVersion}.exe`,
    oldInstaller
  );
  await writeFile(preservedData, "preserve-me\n", "utf8");

  await run("beta.7 install", oldInstaller, ["/S", `/D=${installationDirectory}`]);
  await assertInstalledVersion(oldVersion);

  await run("public beta 1 upgrade", newInstaller, ["/S", `/D=${installationDirectory}`]);
  await assertInstalledVersion(expectedVersion);
  await assertPreservedData();

  await run(
    "upgraded app smoke",
    process.execPath,
    [join(process.cwd(), "apps", "desktop", "scripts", "package-smoke.mjs")],
    {
      COMPAZIO_V2_PACKAGED_EXECUTABLE: executable
    }
  );

  const uninstaller = join(installationDirectory, "Uninstall Compazio Community.exe");
  if (!existsSync(uninstaller)) throw new Error("NSIS uninstaller was not found");
  await run("uninstall", uninstaller, ["/S", `_?=${installationDirectory}`]);
  if (existsSync(executable)) throw new Error("Uninstall left the executable behind");
  await assertPreservedData();

  process.stdout.write(
    `Upgrade smoke passed: ${oldVersion} -> ${expectedVersion}; data preserved; app launched; uninstall passed\n`
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function assertInstalledVersion(expected) {
  const packageFile = join(installationDirectory, "resources", "app", "package.json");
  const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
  if (packageJson.version !== expected)
    throw new Error(`Expected installed version ${expected}, received ${packageJson.version}`);
}

async function assertPreservedData() {
  if ((await readFile(preservedData, "utf8")).trim() !== "preserve-me")
    throw new Error("Data outside the installation directory was not preserved");
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null)
    throw new Error(`Could not download ${basename(destination)}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function run(label, command, args, extraEnvironment = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
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
