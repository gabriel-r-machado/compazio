import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { COMPAZIO_CLI_COMMAND, prependToPath, provisionCompazioCli } from "./cli-provisioning";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true }));
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "compazio-cli-bin-"));
  directories.push(directory);
  return directory;
}

describe("provisionCompazioCli", () => {
  it("installs a Windows command that runs the bundled CLI through the app's Electron", () => {
    const binDirectory = join(tempDirectory(), "bin");

    const provisioned = provisionCompazioCli({
      binDirectory,
      electronExecutable: "C:\\Program Files\\Compazio\\Compazio.exe",
      cliEntrypoint: "C:\\Program Files\\Compazio\\resources\\app\\compazio-cli.js",
      platform: "win32"
    });

    expect(provisioned.commandPath).toBe(join(binDirectory, `${COMPAZIO_CLI_COMMAND}.cmd`));
    const contents = readFileSync(provisioned.commandPath, "utf8");
    // Electron's own node runtime keeps the native sqlite binding on the ABI it was built for.
    expect(contents).toContain("ELECTRON_RUN_AS_NODE=1");
    // Quoted so a Program Files path survives, and %* so the agent's own arguments pass through.
    expect(contents).toContain(
      '"C:\\Program Files\\Compazio\\Compazio.exe" "C:\\Program Files\\Compazio\\resources\\app\\compazio-cli.js" %*'
    );
    expect(contents).toContain("exit /b %ERRORLEVEL%");
  });

  it("installs a POSIX command", () => {
    const binDirectory = join(tempDirectory(), "bin");

    const provisioned = provisionCompazioCli({
      binDirectory,
      electronExecutable: "/Applications/Compazio.app/Contents/MacOS/Compazio",
      cliEntrypoint: "/Applications/Compazio.app/Contents/Resources/app/compazio-cli.js",
      platform: "darwin"
    });

    expect(provisioned.commandPath).toBe(join(binDirectory, COMPAZIO_CLI_COMMAND));
    const contents = readFileSync(provisioned.commandPath, "utf8");
    expect(contents.startsWith("#!/bin/sh")).toBe(true);
    expect(contents).toContain('"$@"');
  });

  // NTFS cannot represent a POSIX execute bit, so a Windows host would pass this vacuously.
  it.skipIf(process.platform === "win32")("marks the POSIX command executable", () => {
    const binDirectory = join(tempDirectory(), "bin");

    const provisioned = provisionCompazioCli({
      binDirectory,
      electronExecutable: "/opt/compazio/compazio",
      cliEntrypoint: "/opt/compazio/compazio-cli.js",
      platform: "linux"
    });

    expect(statSync(provisioned.commandPath).mode & 0o111).not.toBe(0);
  });

  it("rewrites the command when an app update moves the paths", () => {
    const binDirectory = join(tempDirectory(), "bin");
    const install = (version: string) =>
      provisionCompazioCli({
        binDirectory,
        electronExecutable: `C:\\Compazio\\${version}\\Compazio.exe`,
        cliEntrypoint: `C:\\Compazio\\${version}\\compazio-cli.js`,
        platform: "win32"
      });

    install("1.0.0");
    const provisioned = install("1.1.0");

    const contents = readFileSync(provisioned.commandPath, "utf8");
    expect(contents).toContain("1.1.0");
    expect(contents).not.toContain("1.0.0");
  });

  it("refuses a relative path, which would resolve against the agent's own cwd", () => {
    const binDirectory = join(tempDirectory(), "bin");

    expect(() =>
      provisionCompazioCli({
        binDirectory,
        electronExecutable: "Compazio.exe",
        cliEntrypoint: "C:\\Compazio\\compazio-cli.js",
        platform: "win32"
      })
    ).toThrow("must be absolute");
  });
});

describe("prependToPath", () => {
  it("puts the command directory first on Windows without duplicating an existing Path", () => {
    const environment = prependToPath(
      { Path: "C:\\Windows;C:\\Windows\\System32", TERM: "xterm-256color" },
      "C:\\Users\\dev\\AppData\\Local\\Compazio\\bin",
      "win32"
    );

    expect(environment).toEqual({
      Path: "C:\\Users\\dev\\AppData\\Local\\Compazio\\bin;C:\\Windows;C:\\Windows\\System32",
      TERM: "xterm-256color"
    });
    expect(Object.keys(environment)).not.toContain("PATH");
  });

  it("uses the POSIX separator", () => {
    expect(prependToPath({ PATH: "/usr/bin" }, "/home/dev/.compazio/bin", "linux")).toEqual({
      PATH: "/home/dev/.compazio/bin:/usr/bin"
    });
  });

  it("creates PATH when the environment has none", () => {
    expect(prependToPath({ TERM: "xterm-256color" }, "/opt/compazio/bin", "linux")).toEqual({
      TERM: "xterm-256color",
      PATH: "/opt/compazio/bin"
    });
  });
});
