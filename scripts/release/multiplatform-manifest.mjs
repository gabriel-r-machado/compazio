import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const options = parseArguments(process.argv.slice(2));
const directory = resolve(options.directory);
const files = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter(isReleaseAsset)
  .sort();

const windows = await requiredAsset("Windows NSIS", files, (name) =>
  /^Compazio-Setup-.+\.exe$/i.test(name)
);
const macArm64 = await requiredAsset("macOS arm64 DMG", files, (name) =>
  /^Compazio-.+-arm64\.dmg$/i.test(name)
);
const macX64 = await requiredAsset("macOS x64 DMG", files, (name) =>
  /^Compazio-.+-x64\.dmg$/i.test(name)
);
const appImage = await requiredAsset("Linux AppImage", files, (name) =>
  /^Compazio-.+-(?:x64|x86_64)\.AppImage$/i.test(name)
);
const deb = await requiredAsset("Linux deb", files, (name) =>
  /^compazio_.+_(?:amd64|x64)\.deb$/i.test(name)
);
const rpm = await optionalAsset("Linux RPM", files, (name) =>
  /^compazio-.+\.(?:x86_64|x64)\.rpm$/i.test(name)
);
const pacman = await optionalAsset("Linux Pacman", files, (name) =>
  /^compazio-.+\.pkg\.tar\.zst$/i.test(name)
);

const artifacts = await Promise.all(files.map((filename) => artifact(filename)));
const releaseTag = `v${options.version}`;
const assetUrl = (filename) =>
  `https://github.com/${options.repository}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(filename)}`;
const releaseAsset = (item, platform, architecture, type) => ({
  platform,
  architecture,
  type,
  url: assetUrl(item.filename),
  sha256: item.sha256,
  byteSize: item.byteSize
});
const linuxArtifacts = {
  appImage: releaseAsset(appImage, "linux", "x64", "appImage"),
  deb: releaseAsset(deb, "linux", "x64", "deb")
};
if (rpm) linuxArtifacts.rpm = releaseAsset(rpm, "linux", "x64", "rpm");
if (pacman) linuxArtifacts.pacman = releaseAsset(pacman, "linux", "x64", "pacman");

const manifest = {
  schemaVersion: "1.0",
  version: options.version,
  channel: options.channel,
  release: {
    tag: releaseTag,
    url: `https://github.com/${options.repository}/releases/tag/${encodeURIComponent(releaseTag)}`
  },
  platforms: {
    windows: { x64: releaseAsset(windows, "windows", "x64", "exe") },
    macos: {
      arm64: releaseAsset(macArm64, "macos", "arm64", "dmg"),
      x64: releaseAsset(macX64, "macos", "x64", "dmg")
    },
    linux: {
      x64: linuxArtifacts
    }
  },
  artifacts,
  createdAt: new Date().toISOString()
};

await writeFile(joined("release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(
  joined("SHA256SUMS.txt"),
  `${artifacts.map((item) => `${item.sha256}  ${item.filename}`).join("\n")}\n`,
  "utf8"
);
await writeFile(joined("RELEASE_NOTES.md"), releaseNotes(options.version), "utf8");
process.stdout.write(`Multiplatform release manifest written to ${directory}\n`);

function joined(filename) {
  return `${directory}/${filename}`;
}

async function requiredAsset(label, names, predicate) {
  const matches = names.filter(predicate);
  if (matches.length !== 1)
    throw new Error(`${label} requires exactly one artifact; found ${matches.length}.`);
  return artifact(matches[0]);
}

async function optionalAsset(label, names, predicate) {
  const matches = names.filter(predicate);
  if (matches.length === 0) return null;
  if (matches.length > 1)
    throw new Error(`${label} expected at most one artifact; found ${matches.length}.`);
  return artifact(matches[0]);
}

async function artifact(filename) {
  const content = await readFile(joined(filename));
  return {
    filename: basename(filename),
    byteSize: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

function isReleaseAsset(filename) {
  return /\.(?:appimage|blockmap|deb|dmg|exe|pkg\.tar\.zst|rpm|yml)$/i.test(filename);
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !["--directory", "--version", "--channel", "--repository"].includes(key)
    )
      throw new Error(
        "Usage: --directory <path> --version <semver> --channel <beta> --repository <owner/repo>"
      );
    if (values.has(key)) throw new Error(`Option was provided twice: ${key}`);
    values.set(key, value);
  }
  const directory = values.get("--directory");
  const version = values.get("--version");
  const channel = values.get("--channel");
  const repository = values.get("--repository");
  if (
    typeof directory !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version) ||
    channel !== "beta" ||
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  )
    throw new Error("Invalid multiplatform release manifest options.");
  return { directory, version, channel, repository };
}

function releaseNotes(version) {
  return `# Compazio ${version}

Beta de distribuição multiplataforma do Compazio, o workspace local-first para orquestração visual de agentes e terminais.

## Downloads

- Windows x64: instalador NSIS.
- macOS Apple Silicon e Intel: DMG.
- Linux x64: AppImage, pacote .deb, pacote .rpm e pacote nativo Pacman (Arch Linux).

## Atualizações

O canal beta com atualização dentro do aplicativo permanece habilitado somente no Windows. Em macOS e Linux, use o download manual desta release enquanto os caminhos nativos de atualização não forem validados.

## Assinatura

Esta beta é distribuída sem certificado pago. O Windows pode mostrar um aviso do SmartScreen e o macOS pode solicitar uma confirmação do Gatekeeper. Não use certificados autoassinados como substituto de confiança pública.

## Dados locais

Atualizações e reinstalações preservam os dados do usuário no diretório gerenciado pelo Electron. A desinstalação remove o aplicativo, não os workspaces locais.
`;
}
