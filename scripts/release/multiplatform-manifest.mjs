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
await requiredAsset("Windows blockmap", files, (name) =>
  /^Compazio-Setup-.+\.exe\.blockmap$/i.test(name)
);
await requiredAsset("Windows update metadata", files, (name) => /^beta\.yml$/i.test(name));

const appImage = await requiredAsset("Linux AppImage", files, (name) =>
  /^Compazio-.+-(?:x64|x86_64)\.AppImage$/i.test(name)
);
const deb = await requiredAsset("Linux DEB", files, (name) =>
  /^compazio_.+_(?:amd64|x64)\.deb$/i.test(name)
);
const rpm = await requiredAsset("Linux RPM", files, (name) =>
  /^compazio-.+\.(?:x86_64|x64)\.rpm$/i.test(name)
);
const pacman = await requiredAsset("Linux Pacman", files, (name) =>
  /^compazio-.+-x64\.pkg\.tar\.zst$/i.test(name)
);

await requiredAsset("Arch PKGBUILD", files, (name) => name === "PKGBUILD");
await requiredAsset("Arch SRCINFO", files, (name) => name === ".SRCINFO");
await requiredAsset("Arch desktop entry", files, (name) => name === "compazio.desktop");

const macArm64 = await optionalAsset("macOS arm64 DMG", files, (name) =>
  /^Compazio-.+-arm64\.dmg$/i.test(name)
);
const macX64 = await optionalAsset("macOS x64 DMG", files, (name) =>
  /^Compazio-.+-x64\.dmg$/i.test(name)
);
if ((macArm64 === null) !== (macX64 === null))
  throw new Error("macOS release requires both arm64 and x64 DMG artifacts when enabled.");

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

const platforms = {
  windows: {
    x64: releaseAsset(windows, "windows", "x64", "exe")
  },
  linux: {
    x64: {
      appImage: releaseAsset(appImage, "linux", "x64", "appImage"),
      deb: releaseAsset(deb, "linux", "x64", "deb"),
      rpm: releaseAsset(rpm, "linux", "x64", "rpm"),
      pacman: releaseAsset(pacman, "linux", "x64", "pacman")
    }
  }
};

if (macArm64 !== null && macX64 !== null) {
  platforms.macos = {
    arm64: releaseAsset(macArm64, "macos", "arm64", "dmg"),
    x64: releaseAsset(macX64, "macos", "x64", "dmg")
  };
}

const manifest = {
  schemaVersion: "1.0",
  version: options.version,
  channel: options.channel,
  release: {
    tag: releaseTag,
    url: `https://github.com/${options.repository}/releases/tag/${encodeURIComponent(releaseTag)}`
  },
  platforms,
  distributionMetadata: {
    arch: {
      pkgbuild: assetUrl("PKGBUILD"),
      srcinfo: assetUrl(".SRCINFO"),
      desktopEntry: assetUrl("compazio.desktop"),
      aurPublished: false
    }
  },
  artifacts: artifacts.map((item) => ({
    ...item,
    url: assetUrl(item.filename)
  })),
  createdAt: new Date().toISOString()
};

await writeFile(joined("release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(
  joined("checksums.txt"),
  `${artifacts.map((item) => `${item.sha256}  ${item.filename}`).join("\n")}\n`,
  "utf8"
);
await writeFile(
  joined("RELEASE_NOTES.md"),
  releaseNotes(options.version, macArm64 !== null && macX64 !== null),
  "utf8"
);
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
  return (
    /\.(?:appimage|blockmap|deb|dmg|exe|pkg\.tar\.zst|rpm|yml)$/i.test(filename) ||
    filename === "PKGBUILD" ||
    filename === ".SRCINFO" ||
    filename === "compazio.desktop"
  );
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

function releaseNotes(version, includesMac) {
  const macDownload = includesMac ? "- macOS Apple Silicon e Intel: DMG.\n" : "";
  const macNotice = includesMac
    ? "No macOS, use o download manual desta release enquanto o caminho nativo de atualização não for validado.\n"
    : "";

  return `# Compazio ${version}

Beta de distribuição do Compazio Community, o workspace local-first para orquestração visual de agentes e terminais.

## Downloads

- Windows x64: instalador NSIS.
- Linux x64: AppImage, .deb, .rpm e pacote nativo Pacman (.pkg.tar.zst).
${macDownload}
## Arch Linux / AUR

A release inclui \`PKGBUILD\`, \`.SRCINFO\` e \`compazio.desktop\` para facilitar uma futura publicação no AUR. O manifesto marca explicitamente \`aurPublished: false\`; não anuncie \`yay -S compazio-bin\` até o pacote estar publicado.

## Atualizações

O canal beta com atualização dentro do aplicativo permanece habilitado somente no Windows. No Linux, use o download manual desta release.
${macNotice}
## Assinatura

Esta beta pode ser distribuída sem certificado pago. O Windows pode mostrar um aviso do SmartScreen.
${includesMac ? "O macOS pode solicitar uma confirmação do Gatekeeper.\n" : ""}
## Dados locais

Atualizações e reinstalações preservam os dados do usuário no diretório gerenciado pelo Electron. A desinstalação remove o aplicativo, não os workspaces locais.
`;
}
