import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");
const rootPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const version = rootPackage.version;
const archVersion = version.replaceAll("-", "_");

const desktopFile = join(scriptDirectory, "compazio.desktop");
const desktopContent = await readFile(desktopFile);
const desktopSha256 = createHash("sha256").update(desktopContent).digest("hex");

// Optional path to the built AppImage to calculate hash, otherwise placeholder
const explicitAppImagePath = process.argv[2];
const appImagePath =
  explicitAppImagePath ?? join(repoRoot, "release", version, `Compazio-${version}-x64.AppImage`);
let appImageSha256 = "SKIP";

try {
  const appImageContent = await readFile(appImagePath);
  appImageSha256 = createHash("sha256").update(appImageContent).digest("hex");
} catch (error) {
  if (explicitAppImagePath !== undefined) throw error;
  process.stdout.write(`AppImage not found at ${appImagePath}; using placeholder checksum.\n`);
}

const templatePath = join(scriptDirectory, "PKGBUILD.template");
const template = await readFile(templatePath, "utf8");

const pkgbuildContent = template
  .replaceAll("__PKGVER__", archVersion)
  .replaceAll("__UPSTREAM_VERSION__", version)
  .replaceAll("__APPIMAGE_SHA256__", appImageSha256)
  .replaceAll("__DESKTOP_SHA256__", desktopSha256);

const targetPkgbuild = join(scriptDirectory, "PKGBUILD");
await writeFile(targetPkgbuild, pkgbuildContent, "utf8");

const srcinfoContent = `pkgbase = compazio-bin
\tpkgdesc = Orquestração visual de agentes e terminais
\tpkgver = ${archVersion}
\tpkgrel = 1
\turl = https://www.compazio.app
\tarch = x86_64
\tlicense = AGPL-3.0-only
\tdepends = alsa-lib
\tdepends = gtk3
\tdepends = libnotify
\tdepends = nss
\tdepends = libsecret
\tdepends = libxss
\tdepends = libxtst
\tdepends = xdg-utils
\tdepends = fuse2
\toptdepends = git: Controle de versão integrado
\tprovides = compazio
\tconflicts = compazio
\toptions = !strip
\tsource = Compazio-${version}-x64.AppImage::https://github.com/gabriel-r-machado/compazio/releases/download/v${version}/Compazio-${version}-x64.AppImage
\tsource = compazio.desktop
\tsha256sums = ${appImageSha256}
\tsha256sums = ${desktopSha256}

pkgname = compazio-bin
`;

const targetSrcinfo = join(scriptDirectory, ".SRCINFO");
await writeFile(targetSrcinfo, srcinfoContent, "utf8");

process.stdout.write(`Arch Linux AUR files generated successfully in ${scriptDirectory}\n`);
