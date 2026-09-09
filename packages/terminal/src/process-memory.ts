import { execFile } from "node:child_process";
import { join } from "node:path";

import type { RuntimePlatform } from "@forgedeck/agent-sdk";

/**
 * Reads how much memory the processes under a terminal session are using.
 *
 * This exists for one job: catching a runaway agent before it takes the machine down with it. A
 * single coding agent commonly sits at several hundred megabytes, and this product actively
 * encourages running many at once, so one leaking tool can starve everything else the person is
 * doing — including the terminals that are behaving.
 *
 * Only descendants are ever reported as candidates for killing. The session's own root process is
 * the shell the person is looking at; killing that would take the terminal with it, which is exactly
 * the outcome the limit is supposed to prevent.
 */

export interface ProcessMemoryUsage {
  readonly processId: number;
  readonly parentProcessId: number;
  /** Resident set size in bytes. */
  readonly residentBytes: number;
}

export interface ProcessMemoryReader {
  /** Every live process on the host, with its parent and resident size. */
  read(): Promise<readonly ProcessMemoryUsage[]>;
}

export class PlatformProcessMemoryReader implements ProcessMemoryReader {
  public constructor(private readonly platform: RuntimePlatform = currentPlatform()) {}

  public async read(): Promise<readonly ProcessMemoryUsage[]> {
    if (this.platform === "win32") {
      const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
      const powershell = join(
        windowsDirectory,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
      const output = await run(powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // CSV keeps the parsing trivial and locale-independent, unlike the default table rendering.
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Csv -NoTypeInformation"
      ]);
      return parseWindowsProcessCsv(output);
    }
    const output = await run("/bin/ps", ["-eo", "pid=,ppid=,rss="]);
    return parsePosixProcessTable(output);
  }
}

/** `WorkingSetSize` is already bytes; `ps` reports kilobytes. Both become bytes here. */
export function parseWindowsProcessCsv(output: string): readonly ProcessMemoryUsage[] {
  const rows: ProcessMemoryUsage[] = [];
  for (const line of output.split(/\r?\n/).slice(1)) {
    const fields = line.split(",").map((field) => field.replace(/^"|"$/g, "").trim());
    if (fields.length < 3) continue;
    const usage = toUsage(fields[0], fields[1], fields[2], 1);
    if (usage !== null) rows.push(usage);
  }
  return rows;
}

export function parsePosixProcessTable(output: string): readonly ProcessMemoryUsage[] {
  const rows: ProcessMemoryUsage[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const usage = toUsage(fields[0], fields[1], fields[2], 1024);
    if (usage !== null) rows.push(usage);
  }
  return rows;
}

/**
 * The processes below `rootPid`, excluding the root itself. Built from the parent links rather than
 * asking the OS per process, so one snapshot answers for every session at once.
 */
export function descendantsOf(
  processes: readonly ProcessMemoryUsage[],
  rootPid: number
): readonly ProcessMemoryUsage[] {
  const childrenByParent = new Map<number, ProcessMemoryUsage[]>();
  for (const entry of processes) {
    const siblings = childrenByParent.get(entry.parentProcessId);
    if (siblings === undefined) childrenByParent.set(entry.parentProcessId, [entry]);
    else siblings.push(entry);
  }
  const descendants: ProcessMemoryUsage[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) break;
    for (const child of childrenByParent.get(parent) ?? []) {
      // A recycled pid can make the parent links look circular; visiting each pid once ends it.
      if (seen.has(child.processId)) continue;
      seen.add(child.processId);
      descendants.push(child);
      queue.push(child.processId);
    }
  }
  return descendants;
}

function toUsage(
  pid: string | undefined,
  parentPid: string | undefined,
  memory: string | undefined,
  memoryUnitBytes: number
): ProcessMemoryUsage | null {
  const processId = Number(pid);
  const parentProcessId = Number(parentPid);
  const residentBytes = Number(memory);
  if (
    !Number.isInteger(processId) ||
    processId <= 0 ||
    !Number.isInteger(parentProcessId) ||
    parentProcessId < 0 ||
    !Number.isFinite(residentBytes) ||
    residentBytes < 0
  ) {
    return null;
  }
  return { processId, parentProcessId, residentBytes: residentBytes * memoryUnitBytes };
}

function run(executable: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else reject(error instanceof Error ? error : new Error("Process listing failed"));
      }
    );
  });
}

function currentPlatform(): RuntimePlatform {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error(`Unsupported runtime platform: ${process.platform}`);
}
