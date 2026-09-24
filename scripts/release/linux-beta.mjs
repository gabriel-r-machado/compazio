import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");
const rootPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const version = rootPackage.version;
const desktopReleaseDirectory = join(repoRoot, "apps", "desktop", "release");
const artifactDirectory = join(repoRoot, "release", version);
const archPackagingDirectory = join(repoRoot, "packaging", "arch");

if (process.platform !== "linux") throw new Error("Linux beta packaging requires Linux");
await assertGitReady();

await runPnpm("restore host native modules", ["--filter", "@forgedeck/desktop", "native:node"]);
try {
  await runPnpm("lint", ["lint"]);
  await runPnpm("typecheck", ["typecheck"]);
  await runPnpm("unit tests", ["test"]);
  await runPnpm("integration tests", ["test:integration"]);
  await rm(desktopReleaseDirectory, { recursive: true, force: true });
  await runPnpm("package Linux targets", ["--filter", "@forgedeck/desktop", "package:linux"]);
  await run("package audit", process.execPath, [
    join(repoRoot, "scripts", "release", "audit-linux-package.mjs"),
    "--directory",
    join(desktopReleaseDirectory, "linux-unpacked")
  ]);
  await runPnpm("unpacked and packaged smoke", [
    "--filter",
    "@forgedeck/desktop",
    "release:smoke:linux"
  ]);
} finally {
  await runPnpm("restore host native modules", ["--filter", "@forgedeck/desktop", "native:node"]);
}

const packageFiles = await readdir(desktopReleaseDirectory);
const appImage = requiredFile(
  "Linux AppImage",
  packageFiles,
  (name) => /^Compazio-.+-(?:x64|x86_64)\.AppImage$/i.test(name)
);
const deb = requiredFile(
  "Linux DEB",
  packageFiles,
  (name) => /^compazio_.+_(?:amd64|x64)\.deb$/i.test(name)
);
const rpm = requiredFile(
  "Linux RPM",
  packageFiles,
  (name) => /^compazio-.+\.(?:x86_64|x64)\.rpm$/i.test(name)
);
const pacman = requiredFile(
  "Linux Pacman",
  packageFiles,
  (name) => /^compazio-.+-x64\.pkg\.tar\.zst$/i.test(name)
);

await run("generate AUR assets", process.execPath, [
  join(archPackagingDirectory, "generate-aur.mjs"),
  join(desktopReleaseDirectory, appImage)
]);

await rm(artifactDirectory, { recursive: true, force: true });
await mkdir(artifactDirectory, { recursive: true });

const sources = [
  [join(desktopReleaseDirectory, appImage), appImage],
  [join(desktopReleaseDirectory, deb), deb],
  [join(desktopReleaseDirectory, rpm), rpm],
  [join(desktopReleaseDirectory, pacman), pacman],
  [join(archPackagingDirectory, "PKGBUILD"), "PKGBUILD"],
  [join(archPackagingDirectory, ".SRCINFO"), ".SRCINFO"],
  [join(archPackagingDirectory, "compazio.desktop"), "compazio.desktop"]
];

const checksumLines = [];
const artifactRecords = [];

for (const [sourcePath, filename] of sources) {
  const targetPath = join(artifactDirectory, filename);
  await copyFile(sourcePath, targetPath);

  const fileStats = await stat(targetPath);
  const fileSha256 = await sha256(targetPath);
  checksumLines.push(`${fileSha256}  ${filename}`);
  artifactRecords.push({
    file: filename,
    sha256: fileSha256,
    byteSize: fileStats.size
  });
}

await writeFile(join(artifactDirectory, "checksums.txt"), `${checksumLines.join("\n")}\n`, "utf8");

const manifest = {
  product: "Compazio",
  channel: "beta",
  version,
  platform: "linux",
  architecture: "x64",
  artifacts: artifactRecords,
  publishedAt: new Date().toISOString(),
  minimumRequirements: {
    platform: "Linux",
    architecture: "x64"
  }
};

await writeFile(
  join(artifactDirectory, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);

const releaseNotes = `# Compazio ${version} — Linux Beta

Beta público do núcleo de orquestração visual local do Compazio para Linux.

## Formatos disponíveis

- **AppImage:** executável portátil para Linux x86_64.
- **RPM:** pacote para distribuições baseadas em RPM.
- **Pacman / Arch Linux:** pacote nativo \`.pkg.tar.zst\`.
- **DEB:** pacote para distribuições baseadas em Debian.

Os arquivos \`PKGBUILD\` e \`.SRCINFO\` acompanham os artefatos para facilitar uma futura publicação no AUR. Isso não significa que \`compazio-bin\` já esteja publicado no AUR.

## Instalação

### AppImage

\`\`\`bash
chmod +x Compazio-${version}-x64.AppImage
./Compazio-${version}-x64.AppImage
\`\`\`

### RPM

\`\`\`bash
sudo dnf install ./compazio-${version}.x86_64.rpm
\`\`\`

### Arch Linux

\`\`\`bash
sudo pacman -U compazio-${version}-x64.pkg.tar.zst
\`\`\`

### Debian / Ubuntu

\`\`\`bash
sudo apt install ./compazio_${version}_amd64.deb
\`\`\`
`;

await writeFile(join(artifactDirectory, "RELEASE_NOTES.md"), releaseNotes, "utf8");
process.stdout.write(`Linux beta artifacts ready in: ${artifactDirectory}\n`);

function requiredFile(label, names, predicate) {
  const matches = names.filter(predicate);
  if (matches.length !== 1)
    throw new Error(`${label} requires exactly one artifact; found ${matches.length}.`);
  return matches[0];
}

async function assertGitReady() {
  const status = await capture("git", ["status", "--short", "--untracked-files=no"]);
  if (status.trim() !== "") throw new Error(`Git must be clean before packaging:\n${status}`);
}

async function sha256(filename) {
  const content = await readFile(filename);
  return createHash("sha256").update(content).digest("hex");
}

function run(label, command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function runPnpm(label, args) {
  return run(label, "pnpm", args);
}

function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} failed: ${stderr || stdout}`));
    });
  });
}
