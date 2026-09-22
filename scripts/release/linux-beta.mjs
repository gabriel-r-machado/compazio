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

await rm(artifactDirectory, { recursive: true, force: true });
await mkdir(artifactDirectory, { recursive: true });

const releaseFiles = (await readdir(desktopReleaseDirectory)).filter(
  (file) =>
    /\.(?:appimage|deb|rpm|pkg\.tar\.zst|blockmap|yml)$/i.test(file) ||
    /^(release-manifest\.json|checksums\.txt|RELEASE_NOTES\.md)$/i.test(file)
);

const checksumLines = [];
const artifactRecords = [];

for (const file of releaseFiles) {
  const sourcePath = join(desktopReleaseDirectory, file);
  const targetPath = join(artifactDirectory, file);
  await copyFile(sourcePath, targetPath);

  const fileStats = await stat(sourcePath);
  const fileSha256 = await sha256(sourcePath);
  checksumLines.push(`${fileSha256}  ${file}`);
  artifactRecords.push({
    file,
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
    architecture: "x64",
    glibc: ">= 2.31"
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

- **AppImage:** Executável portátil para todas as distribuições x86_64.
- **RPM:** Pacote para Fedora, RHEL, CentOS, openSUSE, Rocky Linux e AlmaLinux.
- **Pacman / Arch Linux:** Pacote nativo \`.pkg.tar.zst\` e suporte via AUR (\`compazio-bin\`).
- **DEB:** Pacote para Debian, Ubuntu, Linux Mint e Pop!_OS.

## Instalação

### AppImage
\`\`\`bash
chmod +x Compazio-${version}-x64.AppImage
./Compazio-${version}-x64.AppImage
\`\`\`

### Fedora / RHEL / openSUSE (RPM)
\`\`\`bash
sudo dnf install ./compazio-${version}.x86_64.rpm
# ou
sudo zypper install ./compazio-${version}.x86_64.rpm
\`\`\`

### Arch Linux
\`\`\`bash
# Pacote nativo:
sudo pacman -U compazio-${version}-x86_64.pkg.tar.zst

# Ou via AUR:
yay -S compazio-bin
\`\`\`

### Debian / Ubuntu (DEB)
\`\`\`bash
sudo apt install ./compazio_${version}_amd64.deb
\`\`\`

## Recursos incluídos

- Canvas persistente com terminais PTY reais e isolamento de processos;
- Integração de agentes (Claude Code, Codex, OpenCode);
- Barramento de mensagens e coordenação entre agentes;
- Visualização de notas Markdown e árvore de arquivos;
- Diagnóstico sanitizado e restauração segura de workspace.
`;

await writeFile(join(artifactDirectory, "RELEASE_NOTES.md"), releaseNotes, "utf8");

// Generate AUR package definitions
try {
  await run("generate AUR assets", process.execPath, [
    join(repoRoot, "packaging", "arch", "generate-aur.mjs"),
    join(artifactDirectory, `Compazio-${version}-x64.AppImage`)
  ]);
} catch (error) {
  process.stderr.write(`Warning: could not generate Arch AUR assets: ${error.message}\n`);
}

process.stdout.write(`Linux beta artifacts ready in: ${artifactDirectory}\n`);

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
