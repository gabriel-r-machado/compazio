import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

import type {
  DetectedExecutable,
  ExecutableDetectionContext,
  ExecutableDetector
} from "@forgedeck/agent-sdk";

export class PathExecutableDetector implements ExecutableDetector {
  public async find(
    candidates: readonly string[],
    context: ExecutableDetectionContext
  ): Promise<DetectedExecutable | null> {
    const pathEntries = (readEnvironment(context.environment, "PATH") ?? "")
      .split(delimiter)
      .filter((entry) => entry.length > 0);
    const extensions = getExtensions(context);

    for (const candidate of candidates) {
      const basePaths = isAbsolute(candidate)
        ? [candidate]
        : pathEntries.map((entry) => join(entry, candidate));
      for (const basePath of basePaths) {
        const paths =
          extname(basePath) === "" ? extensions.map((ext) => `${basePath}${ext}`) : [basePath];
        for (const executablePath of paths) {
          if (await isExecutable(executablePath, context.platform)) {
            return {
              path: executablePath,
              kind: isCommandShim(executablePath) ? "command-shim" : "native"
            };
          }
        }
      }
    }
    return null;
  }
}

function getExtensions(context: ExecutableDetectionContext): readonly string[] {
  if (context.platform !== "win32") {
    return [""];
  }
  const pathExt = readEnvironment(context.environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  return pathExt
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
}

function readEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const entry = Object.entries(environment).find(([key]) => key.toUpperCase() === name);
  return entry?.[1];
}

async function isExecutable(
  path: string,
  platform: ExecutableDetectionContext["platform"]
): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isCommandShim(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}
