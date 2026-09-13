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
const installerName = `Compazio-Setup-${version}.exe`;

if (process.platform !== "win32") throw new Error("Windows beta packaging requires Windows");
await assertGitReady();

await runPnpm("restore host native modules", ["--filter", "@forgedeck/desktop", "native:node"]);
try {
  await runPnpm("lint", ["lint"]);
  await runPnpm("typecheck", ["typecheck"]);
  await runPnpm("unit tests", ["test"]);
  await runPnpm("integration tests", ["test:integration"]);
  await rm(desktopReleaseDirectory, { recursive: true, force: true });
  await runPnpm("package Windows x64", ["--filter", "@forgedeck/desktop", "package"]);
  await run("package audit", process.execPath, [
    join(repoRoot, "scripts", "release", "audit-windows-package.mjs"),
    "--directory",
    join(desktopReleaseDirectory, "win-unpacked")
  ]);
  await runPnpm("unpacked and packaged smoke", [
    "--filter",
    "@forgedeck/desktop",
    "release:smoke:windows"
  ]);
} finally {
  await runPnpm("restore host native modules", ["--filter", "@forgedeck/desktop", "native:node"]);
}

const installerPath = join(desktopReleaseDirectory, installerName);
const installerStats = await stat(installerPath);
const installerSha256 = await sha256(installerPath);
const installerSigned = await hasValidAuthenticodeSignature(installerPath);
await rm(artifactDirectory, { recursive: true, force: true });
await mkdir(artifactDirectory, { recursive: true });
const releaseFiles = (await readdir(desktopReleaseDirectory)).filter(
  (file) =>
    file === installerName ||
    file === `${installerName}.blockmap` ||
    /^((latest|beta).*\.yml|release-manifest\.json|checksums\.txt|RELEASE_NOTES\.md)$/i.test(file)
);
for (const file of releaseFiles)
  await copyFile(join(desktopReleaseDirectory, file), join(artifactDirectory, file));
if (!releaseFiles.includes(installerName))
  await copyFile(installerPath, join(artifactDirectory, installerName));
await writeFile(
  join(artifactDirectory, "checksums.txt"),
  `${installerSha256}  ${installerName}\n`,
  "utf8"
);
await writeFile(
  join(artifactDirectory, "release-manifest.json"),
  `${JSON.stringify(
    {
      product: "Compazio",
      channel: "beta",
      version,
      platform: "windows",
      architecture: "x64",
      installerFile: installerName,
      installerSha256,
      installerSize: installerStats.size,
      updateMetadataFile: releaseFiles.find((file) => /\.yml$/i.test(file)) ?? null,
      blockmapFile: releaseFiles.find((file) => file.endsWith(".blockmap")) ?? null,
      signed: installerSigned,
      publishedAt: new Date().toISOString(),
      minimumRequirements: { platform: "Windows", architecture: "x64" }
    },
    null,
    2
  )}\n`,
  "utf8"
);
const signatureNotice = installerSigned
  ? "Este instalador possui assinatura Authenticode válida."
  : "UNSIGNED BETA BUILD — o Windows pode mostrar um aviso do SmartScreen.";
const releaseNotes = `# Compazio ${version} — Public Beta 1

Beta público do núcleo de orquestração visual local do Compazio para Windows.

## Incluído

- canvas persistente com terminais PTY reais;
- Claude Code, Codex e OpenCode;
- conexões entre agentes com send, reply, wait e inbox;
- notas Markdown, árvore de arquivos básica e portais web;
- restauração do workspace e diagnóstico sanitizado.

## Correções desta versão

- sincronização transacional entre o grid do xterm e o PTY durante resize, zoom e restauração;
- renderização ANSI/truecolor e glyphs preservada com WebGL ou fallback DOM;
- rolagem real nas TUIs do Claude Code, Codex e OpenCode;
- isolamento das instruções e ferramentas do Compazio no processo do agente;
- regressões de teclado, seleção, clipboard, paste grande e encerramento de processos.

## Instalação e atualização

Instale por usuário no Windows x64. Instalar esta versão sobre uma beta anterior preserva os dados
gerenciados pelo aplicativo. O canal beta oferece atualização dentro do Compazio e nunca instala
enquanto há processos ativos.

${signatureNotice}

## Limitações conhecidas

- o suporte multimodal do OpenCode depende do modelo selecionado;
- não há ambientes WSL, SSH ou Docker, portais mobile nem rotinas agendadas;
- a árvore de arquivos ainda não substitui uma IDE ou cliente Git completo;
- este é um beta e pode conter falhas.

## Privacidade e suporte

Use a opção Diagnóstico no menu do Compazio ao reportar problemas. O arquivo omite prompts, notas,
saída de terminal, código, tokens, credenciais e caminhos pessoais.
`;
await writeFile(join(artifactDirectory, "RELEASE_NOTES.md"), releaseNotes, "utf8");
await assertChecksum(join(artifactDirectory, installerName), installerSha256);
process.stdout.write(`Windows beta artifacts ready: ${artifactDirectory}\n`);

async function assertGitReady() {
  const status = await capture("git", ["status", "--short", "--untracked-files=no"]);
  if (status.trim() !== "") throw new Error(`Git must be clean before packaging:\n${status}`);
}

async function hasValidAuthenticodeSignature(filename) {
  const status = await capture("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    join(scriptDirectory, "authenticode-status.ps1"),
    filename
  ]);
  return status.trim() === "Valid";
}

async function sha256(filename) {
  const content = await readFile(filename);
  return createHash("sha256").update(content).digest("hex");
}

async function assertChecksum(filename, expected) {
  const actual = await sha256(filename);
  if (actual !== expected) throw new Error(`Checksum changed after copy: ${filename}`);
}

function run(label, command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      windowsHide: true,
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
  if (process.platform !== "win32") return run(label, "pnpm", args);
  const command = ["pnpm", ...args.map(quoteWindowsArgument)].join(" ");
  return run(label, process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", [
    "/d",
    "/s",
    "/c",
    command
  ]);
}

function quoteWindowsArgument(argument) {
  return /^[a-zA-Z0-9_@./:-]+$/.test(argument) ? argument : `"${argument.replaceAll('"', '\\"')}"`;
}

function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      windowsHide: true,
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
