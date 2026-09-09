import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Dirent } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

import type { LaunchSpec } from "@forgedeck/agent-sdk";
import {
  agentCatalogSchema,
  agentDefinitionSchema,
  agentInstallationSchema,
  agentPresetSchema,
  agentRoleSchema,
  createBuiltInAgentDefinitions,
  roleRevision,
  type AgentCatalog,
  type AgentDefinition,
  type AgentError,
  type AgentErrorCode,
  type AgentInstallation,
  type AgentLaunchRequest,
  type AgentPreset,
  type AgentRole,
  type WorkspacePermissionPolicy
} from "@forgedeck/compazio-v2-domain";

export interface AgentCatalogStore {
  loadAgentCatalog(): Promise<AgentCatalog>;
  saveAgentCatalog(catalog: AgentCatalog): Promise<AgentCatalog>;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(executable: string, args: readonly string[], timeoutMs: number): Promise<CommandResult>;
}

export interface ExecutableResolver {
  resolve(candidates: readonly string[], manualPath?: string): Promise<string | null>;
  validate(path: string): Promise<boolean>;
}

export interface RolePreparation {
  readonly sessionId: string;
  readonly roleId: string;
  readonly revision: string;
  readonly instructionsPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly initialInput: string;
}

export interface AgentLaunchResolution {
  readonly launch: LaunchSpec;
  readonly agentId: string;
  readonly presetId?: string;
  readonly rolePreparation?: RolePreparation;
  readonly permissionNotice?: string;
}

export class AgentOperationError extends Error {
  public constructor(
    public readonly payload: AgentError,
    options?: { readonly cause?: unknown }
  ) {
    super(payload.message, options);
    this.name = "AgentOperationError";
  }
}

export class AgentRegistry {
  private readonly definitions = new Map<string, AgentDefinition>();
  private readonly adapters = new Map<string, AgentAdapter>();

  public constructor(definitions: readonly AgentDefinition[], adapters: readonly AgentAdapter[]) {
    for (const definition of definitions) this.registerDefinition(definition);
    for (const adapter of adapters) this.registerAdapter(adapter);
  }

  public registerDefinition(definition: AgentDefinition): void {
    const validated = agentDefinitionSchema.parse(definition);
    if (this.definitions.has(validated.id))
      throw new Error(`Duplicate agent definition: ${validated.id}`);
    this.definitions.set(validated.id, validated);
  }

  public registerAdapter(adapter: AgentAdapter): void {
    if (!this.definitions.has(adapter.agentId)) {
      throw new Error(`Adapter has no definition: ${adapter.agentId}`);
    }
    if (this.adapters.has(adapter.agentId))
      throw new Error(`Duplicate agent adapter: ${adapter.agentId}`);
    this.adapters.set(adapter.agentId, adapter);
  }

  public listDefinitions(): readonly AgentDefinition[] {
    return [...this.definitions.values()];
  }

  public getDefinition(agentId: string): AgentDefinition {
    const definition = this.definitions.get(agentId);
    if (definition === undefined) {
      throw agentError(
        "AGENT_CONFIGURATION_INVALID",
        "Agente desconhecido.",
        "Escolha um agente registrado."
      );
    }
    return definition;
  }

  public getAdapter(agentId: string): AgentAdapter {
    const adapter = this.adapters.get(agentId);
    if (adapter === undefined) {
      throw agentError(
        "AGENT_CONFIGURATION_INVALID",
        "O adaptador deste agente não está disponível."
      );
    }
    return adapter;
  }
}

export interface AgentAdapter {
  readonly agentId: string;
  detect(context: AgentDetectionContext): Promise<AgentInstallation>;
  validateConfiguration(preset: AgentPreset): Promise<void>;
  resolveLaunch(input: AdapterLaunchInput): Promise<AdapterLaunchResult>;
  /** Resolves a provider-native executable for a private pipe-backed task turn. */
  resolveTaskLaunch?(input: AdapterLaunchInput): Promise<AdapterLaunchResult>;
}

export interface AgentDetectionContext {
  readonly definition: AgentDefinition;
  readonly manualExecutablePath?: string;
  readonly resolver: ExecutableResolver;
  readonly commandRunner: CommandRunner;
  readonly timeoutMs: number;
  readonly now: () => string;
}

export interface AdapterLaunchInput {
  readonly definition: AgentDefinition;
  readonly installation: AgentInstallation;
  readonly preset?: AgentPreset;
  readonly request: AgentLaunchRequest;
  readonly processEnvironment: Readonly<Record<string, string>>;
  readonly resolver: ExecutableResolver;
  readonly rolePreparation?: RolePreparation;
  readonly permissionPolicy: WorkspacePermissionPolicy;
}

export interface AdapterLaunchResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
  readonly environment: Readonly<Record<string, string>>;
  readonly processMode: "pty" | "pipe";
}

/** Resolves an agent from an explicit path or the platform's inherited executable search path. */
export class PlatformExecutableResolver implements ExecutableResolver {
  public constructor(
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly runner: CommandRunner = new NodeCommandRunner(),
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  public async resolve(candidates: readonly string[], manualPath?: string): Promise<string | null> {
    if (manualPath !== undefined)
      return (await this.validate(manualPath)) ? resolve(manualPath) : null;
    for (const candidate of candidates) {
      if (!this.isCandidateSupported(candidate)) continue;
      if (isAbsolute(candidate) && (await this.validate(candidate))) return resolve(candidate);
      for (const directory of this.pathDirectories()) {
        for (const name of executableNames(candidate, this.environment.PATHEXT, this.platform)) {
          const path = join(directory, name);
          if (await this.validate(path)) return path;
        }
      }
      if (this.platform === "win32") {
        // `where.exe` also covers application-specific PATH resolution that a GUI process inherited.
        const result = await this.runner.run("where.exe", [candidate], 1_500).catch(() => null);
        const first = result?.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line !== "" && isWindowsLaunchablePath(line));
        if (first !== undefined && (await this.validate(first))) return first;
      }
    }
    return null;
  }

  public async validate(path: string): Promise<boolean> {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) return false;
      if (this.platform !== "win32") await access(path, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private pathDirectories(): readonly string[] {
    const value = this.environment.PATH ?? this.environment.Path ?? "";
    return value
      .split(this.platform === "win32" ? ";" : ":")
      .map((directory) => directory.trim())
      .filter(Boolean);
  }

  private isCandidateSupported(candidate: string): boolean {
    return this.platform === "win32" || !/\.(?:cmd|bat|exe|com)$/i.test(candidate);
  }
}

/** @deprecated Kept for integrations that imported the former Windows-only name. */
export class WindowsExecutableResolver extends PlatformExecutableResolver {}

export class NodeCommandRunner implements CommandRunner {
  public run(
    executable: string,
    args: readonly string[],
    timeoutMs: number
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const command = prepareDetectedCommand(executable, args);
      const child = spawn(command.executable, command.args, {
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: command.windowsVerbatimArguments
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("command timed out"));
      }, timeoutMs);
      child.stdout?.on("data", (data: Buffer) => (stdout += data.toString("utf8")));
      child.stderr?.on("data", (data: Buffer) => (stderr += data.toString("utf8")));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr });
      });
    });
  }
}

function prepareDetectedCommand(
  executable: string,
  args: readonly string[]
): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
} {
  const extension = extname(executable).toLowerCase();
  if (process.platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) {
    return { executable, args, windowsVerbatimArguments: false };
  }
  const commandProcessor = process.env.ComSpec;
  if (commandProcessor === undefined) {
    throw new Error("COMSPEC is required to inspect a Windows command shim");
  }
  const command = [executable, ...args].map(quoteWindowsArgument).join(" ");
  return {
    executable: commandProcessor,
    args: ["/d", "/s", "/c", `"${command}"`],
    windowsVerbatimArguments: true
  };
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

class InstalledCliAdapter implements AgentAdapter {
  public constructor(public readonly agentId: string) {}

  public async detect(context: AgentDetectionContext): Promise<AgentInstallation> {
    const executablePath = await context.resolver.resolve(
      context.definition.executableCandidates,
      context.manualExecutablePath
    );
    if (executablePath === null) {
      return agentInstallationSchema.parse({
        agentId: this.agentId,
        status: "not-installed",
        detectedAt: context.now(),
        error: {
          code: "AGENT_NOT_INSTALLED",
          message: `${context.definition.name} não foi encontrado.`,
          suggestedAction: "Instale o agente ou informe o caminho do executável."
        }
      });
    }
    try {
      const result = await context.commandRunner.run(
        executablePath,
        ["--version"],
        context.timeoutMs
      );
      const version = firstMeaningfulLine(result.stdout) ?? firstMeaningfulLine(result.stderr);
      if (result.exitCode !== 0) {
        const output = `${result.stdout}\n${result.stderr}`;
        const authenticated = isAuthenticationFailure(output);
        return agentInstallationSchema.parse({
          agentId: this.agentId,
          status: authenticated ? "not-authenticated" : "invalid",
          executablePath,
          ...(version === undefined ? {} : { version }),
          detectedAt: context.now(),
          error: {
            code: authenticated ? "AGENT_NOT_AUTHENTICATED" : "AGENT_EXECUTABLE_INVALID",
            message: authenticated
              ? `${context.definition.name} está instalado, mas requer autenticação.`
              : `${context.definition.name} foi encontrado, mas não passou no healthcheck.`,
            suggestedAction: authenticated
              ? "Autentique o agente e tente novamente."
              : "Verifique o executável configurado."
          }
        });
      }
      return agentInstallationSchema.parse({
        agentId: this.agentId,
        status: "installed",
        executablePath,
        ...(version === undefined ? {} : { version }),
        detectedAt: context.now()
      });
    } catch (error: unknown) {
      const timeout = error instanceof Error && error.message.includes("timed out");
      return agentInstallationSchema.parse({
        agentId: this.agentId,
        status: timeout ? "timed-out" : "invalid",
        executablePath,
        detectedAt: context.now(),
        error: {
          code: timeout ? "AGENT_DETECTION_TIMEOUT" : "AGENT_SPAWN_FAILED",
          message: timeout
            ? `A verificação de ${context.definition.name} excedeu o tempo limite.`
            : `Não foi possível iniciar o healthcheck de ${context.definition.name}.`,
          suggestedAction: "Verifique o executável ou tente novamente."
        }
      });
    }
  }

  public async validateConfiguration(preset: AgentPreset): Promise<void> {
    agentPresetSchema.parse(preset);
    if (preset.agentId !== this.agentId) {
      throw agentError("AGENT_CONFIGURATION_INVALID", "O preset pertence a outro agente.");
    }
  }

  public async resolveLaunch(input: AdapterLaunchInput): Promise<AdapterLaunchResult> {
    const configuredExecutable = input.request.executableOverride ?? input.preset?.executable;
    const executable =
      configuredExecutable === undefined
        ? input.installation.executablePath
        : await input.resolver.resolve(
            [configuredExecutable],
            isAbsolute(configuredExecutable) ? configuredExecutable : undefined
          );
    if (executable === undefined) {
      throw agentError(
        "AGENT_NOT_INSTALLED",
        `${input.definition.name} não está disponível neste computador.`,
        "Instale o agente ou configure um caminho manual."
      );
    }
    if (executable === null) {
      throw agentError(
        "AGENT_EXECUTABLE_INVALID",
        `O executável configurado para ${input.definition.name} não pôde ser resolvido.`,
        "Informe um caminho existente ou remova o override."
      );
    }
    return resolvedLaunch(executable, input);
  }
}

/** Claude Code-specific adapter boundary; shared mechanics intentionally live in the verified CLI base. */
class ClaudeCodeAdapter extends InstalledCliAdapter {
  public constructor() {
    super("claude-code");
  }

  public async resolveTaskLaunch(input: AdapterLaunchInput): Promise<AdapterLaunchResult> {
    const launch = await super.resolveLaunch(input);
    return resolvedTaskLaunch("claude-code", launch.executable, input);
  }
}

/** Codex-specific adapter boundary; it can evolve independently without renderer conditionals. */
class CodexAdapter extends InstalledCliAdapter {
  public constructor() {
    super("codex");
  }

  public override async resolveLaunch(input: AdapterLaunchInput): Promise<AdapterLaunchResult> {
    const launch = await super.resolveLaunch(input);
    // An explicit executable is user-owned. It can be a test adapter, wrapper or another command
    // that merely uses the Codex protocol; Codex-only flags must never be appended to it.
    if (input.request.executableOverride !== undefined || input.preset?.executable !== undefined) {
      return launch;
    }
    if (!/^codex(?:\.(?:exe|cmd|bat))?$/i.test(basename(launch.executable))) return launch;
    const nativeExecutable = await resolveProviderNativeExecutable("codex", launch.executable);
    const configuredModel = input.processEnvironment.COMPAZIO_CODEX_MODEL?.trim();
    if (
      configuredModel !== undefined &&
      (configuredModel.length === 0 || !/^[A-Za-z0-9._/-]{1,128}$/.test(configuredModel))
    ) {
      throw agentError(
        "AGENT_CONFIGURATION_INVALID",
        "COMPAZIO_CODEX_MODEL contém um identificador de modelo inválido."
      );
    }
    // Codex receives invocation-scoped developer instructions. Passing that multiline value through
    // an npm .cmd shim lets cmd.exe reinterpret its contents before Codex sees argv. Prefer the
    // package's real binary so the visible PTY launches the native TUI with the exact arguments.
    const inlineLaunch = {
      ...launch,
      // Codex exposes this invocation-scoped flag specifically to preserve the host terminal's
      // scrollback. Without it the alternate screen owns all history and xterm has nothing to
      // scroll, which made the canvas wheel look broken even though the PTY was healthy.
      args: [
        ...(launch.args.includes("--no-alt-screen") ? [] : ["--no-alt-screen"]),
        ...launch.args,
        ...(configuredModel === undefined ? [] : ["--model", configuredModel])
      ]
    };
    return nativeExecutable === null
      ? inlineLaunch
      : { ...inlineLaunch, executable: nativeExecutable };
  }

  public async resolveTaskLaunch(input: AdapterLaunchInput): Promise<AdapterLaunchResult> {
    const launch = await super.resolveLaunch(input);
    return resolvedTaskLaunch("codex", launch.executable, input);
  }
}

/** OpenCode-specific adapter boundary; it can evolve independently without renderer conditionals. */
class OpenCodeAdapter extends InstalledCliAdapter {
  public constructor() {
    super("opencode");
  }

  public async resolveTaskLaunch(input: AdapterLaunchInput): Promise<AdapterLaunchResult> {
    const launch = await super.resolveLaunch(input);
    return resolvedTaskLaunch("opencode", launch.executable, input);
  }
}

class ShellAdapter implements AgentAdapter {
  public readonly agentId = "shell";

  public async detect(context: AgentDetectionContext): Promise<AgentInstallation> {
    const executablePath = await context.resolver.resolve(
      context.definition.executableCandidates,
      context.manualExecutablePath
    );
    return agentInstallationSchema.parse(
      executablePath === null
        ? {
            agentId: this.agentId,
            status: "not-installed",
            detectedAt: context.now(),
            error: {
              code: "AGENT_EXECUTABLE_NOT_FOUND",
              message: "O shell padrão não foi encontrado."
            }
          }
        : { agentId: this.agentId, status: "installed", executablePath, detectedAt: context.now() }
    );
  }

  public async validateConfiguration(preset: AgentPreset): Promise<void> {
    agentPresetSchema.parse(preset);
  }

  public async resolveLaunch(input: AdapterLaunchInput): Promise<AdapterLaunchResult> {
    const configuredExecutable = input.request.executableOverride ?? input.preset?.executable;
    const executable =
      configuredExecutable === undefined
        ? input.installation.executablePath
        : await input.resolver.resolve(
            [configuredExecutable],
            isAbsolute(configuredExecutable) ? configuredExecutable : undefined
          );
    if (executable === undefined || executable === null) {
      throw agentError(
        "AGENT_EXECUTABLE_NOT_FOUND",
        "O shell selecionado não foi encontrado.",
        "Instale PowerShell ou configure um executável válido."
      );
    }
    return resolvedLaunch(executable, input);
  }
}

class CustomCommandAdapter extends InstalledCliAdapter {
  public constructor() {
    super("custom");
  }

  public override async detect(context: AgentDetectionContext): Promise<AgentInstallation> {
    if (context.manualExecutablePath === undefined) {
      return agentInstallationSchema.parse({
        agentId: this.agentId,
        status: "unknown",
        detectedAt: context.now()
      });
    }
    return super.detect(context);
  }
}

function resolvedLaunch(executable: string, input: AdapterLaunchInput): AdapterLaunchResult {
  const processMode = input.request.processModeOverride ?? input.preset?.processMode ?? "auto";
  const environment = {
    ...input.processEnvironment,
    ...(input.preset?.env ?? {}),
    ...(input.request.envOverrides ?? {}),
    ...(input.rolePreparation?.environment ?? {}),
    COMPAZIO_PERMISSION_POLICY: JSON.stringify(input.permissionPolicy),
    COMPAZIO_PERMISSION_ENFORCEMENT: "workspace-directory-only"
  };
  return {
    executable,
    args: input.request.argsOverride ?? input.preset?.args ?? input.definition.defaultArgs,
    environment,
    processMode: processMode === "pipe" ? "pipe" : "pty"
  };
}

type TaskProvider = "claude-code" | "codex" | "opencode";

/**
 * Prefer a provider's native binary for private workers, with a narrowly scoped ComSpec fallback
 * when npm exposes only a Windows command shim.
 */
async function resolvedTaskLaunch(
  provider: TaskProvider,
  executable: string,
  input: AdapterLaunchInput
): Promise<AdapterLaunchResult> {
  const nativeExecutable = await resolveProviderNativeExecutable(provider, executable);
  if (nativeExecutable === null) {
    const launch = resolvedLaunch(executable, input);
    const commandProcessor =
      launch.environment.ComSpec ??
      launch.environment.COMSPEC ??
      process.env.ComSpec ??
      process.env.COMSPEC;
    if (commandProcessor === undefined) {
      throw agentError(
        "AGENT_CONFIGURATION_INVALID",
        `${provider} has no native executable and no command processor is available.`,
        "Install the native agent or configure COMSPEC."
      );
    }
    const command = [executable, ...launch.args].map(quoteWindowsArgumentForTask).join(" ");
    return {
      ...launch,
      executable: commandProcessor,
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
      processMode: "pipe"
    };
  }
  return {
    ...resolvedLaunch(nativeExecutable, input),
    processMode: "pipe"
  };
}

async function resolveProviderNativeExecutable(
  provider: TaskProvider,
  executable: string
): Promise<string | null> {
  if (!isCommandShim(executable)) return executable;
  if (process.platform !== "win32") {
    throw agentError(
      "AGENT_CONFIGURATION_INVALID",
      `${provider} did not provide a native executable for this background task.`
    );
  }
  const baseDirectory = dirname(executable);
  const executableName =
    provider === "opencode" ? "opencode.exe" : provider === "codex" ? "codex.exe" : "claude.exe";
  const candidates =
    provider === "claude-code"
      ? [join(baseDirectory, "node_modules", "@anthropic-ai", "claude-code", "bin", executableName)]
      : provider === "opencode"
        ? [join(baseDirectory, "node_modules", "opencode-ai", "bin", executableName)]
        : codexNativeCandidates(baseDirectory, executableName);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  // npm installs a .cmd/.bat shim even when a provider does not ship a separately addressable
  // native binary. The private pipe transport can still invoke that wrapper through ComSpec; the
  // fallback is intentionally kept here, at the adapter boundary, so visible terminals remain
  // direct PTY launches and private workers remain non-interactive pipes.
  return null;
}

function isCommandShim(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}

function quoteWindowsArgumentForTask(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function codexNativeCandidates(baseDirectory: string, executableName: string): readonly string[] {
  const targetTriples: Readonly<Record<string, string>> = {
    "win32:x64": "x86_64-pc-windows-msvc",
    "win32:arm64": "aarch64-pc-windows-msvc"
  };
  const targetTriple = targetTriples[`${process.platform}:${process.arch}`];
  if (targetTriple === undefined) return [];
  const packageRoot = join(baseDirectory, "node_modules", "@openai", "codex");
  return [
    join(
      packageRoot,
      "node_modules",
      "@openai",
      `codex-${process.platform}-${process.arch}`,
      "vendor",
      targetTriple,
      "bin",
      executableName
    ),
    join(packageRoot, "vendor", targetTriple, "bin", executableName)
  ];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes role material outside the repository and cleans it by session id. No temporary prompt is persisted in workspace JSON. */
export class RoleInjectionService {
  private readonly paths = new Map<string, string>();

  public constructor(private readonly rootDirectory: string) {}

  public async prepare(input: {
    readonly workspaceId: string;
    readonly terminalNodeId: string;
    readonly sessionId: string;
    readonly role: AgentRole;
  }): Promise<RolePreparation> {
    const directory = join(
      this.rootDirectory,
      input.workspaceId,
      `${input.terminalNodeId}-${input.sessionId}`
    );
    const instructionsPath = join(directory, "instructions.md");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(instructionsPath, input.role.instructions, { encoding: "utf8", flag: "wx" });
      this.paths.set(input.sessionId, directory);
      return {
        sessionId: input.sessionId,
        roleId: input.role.id,
        revision: input.role.revision,
        instructionsPath,
        environment: {
          COMPAZIO_ROLE_ID: input.role.id,
          COMPAZIO_ROLE_REVISION: input.role.revision,
          COMPAZIO_ROLE_INSTRUCTIONS_FILE: instructionsPath,
          COMPAZIO_ROLE_INSTRUCTIONS: input.role.instructions
        },
        // A terminal always starts with an empty editable line. The role remains available through
        // the scoped environment and instructions file, never as text injected into the person's
        // pending command.
        initialInput: ""
      };
    } catch (cause) {
      throw agentError(
        "ROLE_PREPARATION_FAILED",
        "Não foi possível preparar a responsabilidade.",
        undefined,
        cause
      );
    }
  }

  public async cleanup(sessionId: string): Promise<void> {
    const directory = this.paths.get(sessionId);
    if (directory === undefined) return;
    this.paths.delete(sessionId);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cause) {
      throw agentError(
        "ROLE_CLEANUP_FAILED",
        "Não foi possível limpar arquivos temporários da responsabilidade.",
        undefined,
        cause
      );
    }
  }
}

export class PortableRoleService {
  public async discover(workspaceDirectory: string): Promise<readonly AgentRole[]> {
    const root = join(workspaceDirectory, ".compazio", "roles");
    let entries: Dirent<string>[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
    const roles: AgentRole[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = safeRoleDirectory(root, entry.name);
      const roleJson = join(directory, "role.json");
      const instructions = join(directory, "instructions.md");
      const [roleMetadata, instructionStats] = await Promise.all([
        readFile(roleJson, "utf8"),
        lstat(instructions)
      ]);
      if (instructionStats.isSymbolicLink() || !instructionStats.isFile()) {
        throw agentError(
          "ROLE_INVALID",
          `A responsabilidade ${entry.name} possui instruções inseguras.`
        );
      }
      const metadata = JSON.parse(roleMetadata) as Record<string, unknown>;
      if (metadata.schemaVersion !== 1 || metadata.instructionsFile !== "instructions.md") {
        throw agentError(
          "ROLE_INVALID",
          `A responsabilidade ${entry.name} possui formato incompatível.`
        );
      }
      const content = await readFile(instructions, "utf8");
      const now = new Date().toISOString();
      roles.push(
        agentRoleSchema.parse({
          id: metadata.id,
          name: metadata.name,
          ...(typeof metadata.description === "string"
            ? { description: metadata.description }
            : {}),
          ...(isBadge(metadata.badge) ? { badge: metadata.badge } : {}),
          instructions: content,
          revision: roleRevision(content),
          source: "repository",
          scope: "repository",
          portable: true,
          createdAt: now,
          updatedAt: now
        })
      );
    }
    return roles;
  }

  public async export(workspaceDirectory: string, role: AgentRole): Promise<void> {
    const root = join(workspaceDirectory, ".compazio", "roles");
    const directory = safeRoleDirectory(root, role.id);
    try {
      await access(directory);
      throw agentError(
        "ROLE_IMPORT_CONFLICT",
        `A responsabilidade ${role.id} já existe no projeto.`
      );
    } catch (error: unknown) {
      if (error instanceof AgentOperationError) throw error;
      if (!isMissing(error)) throw error;
    }
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "role.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: role.id,
          name: role.name,
          ...(role.description === undefined ? {} : { description: role.description }),
          ...(role.badge === undefined ? {} : { badge: role.badge }),
          instructionsFile: "instructions.md",
          source: "repository"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(join(directory, "instructions.md"), role.instructions, "utf8");
  }
}

export interface AgentRuntimeOptions {
  readonly store: AgentCatalogStore;
  readonly roleInjection: RoleInjectionService;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly resolver?: ExecutableResolver;
  readonly commandRunner?: CommandRunner;
  readonly now?: () => string;
  readonly detectionTimeoutMs?: number;
}

/** Main-process service for registry, discovery, role library and command resolution. */
export class AgentRuntime {
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly now: () => string;
  private readonly resolver: ExecutableResolver;
  private readonly commandRunner: CommandRunner;
  private readonly timeoutMs: number;
  private catalogMutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: AgentRuntimeOptions) {
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? (() => new Date().toISOString());
    this.commandRunner = options.commandRunner ?? new NodeCommandRunner();
    this.resolver =
      options.resolver ?? new PlatformExecutableResolver(this.environment, this.commandRunner);
    this.timeoutMs = options.detectionTimeoutMs ?? 3_000;
  }

  public async listDefinitions(): Promise<readonly AgentDefinition[]> {
    const catalog = await this.catalog();
    const definitions = [
      ...createBuiltInAgentDefinitions(this.now()),
      ...catalog.customDefinitions
    ];
    return new AgentRegistry(definitions, createAdapters()).listDefinitions();
  }

  public async listPresets(): Promise<readonly AgentPreset[]> {
    return (await this.catalog()).presets;
  }

  public async listRoles(): Promise<readonly AgentRole[]> {
    return (await this.catalog()).roles;
  }

  public async detectAll(): Promise<readonly AgentInstallation[]> {
    const definitions = await this.listDefinitions();
    return Promise.all(definitions.map((definition) => this.detectOne(definition.id)));
  }

  public async detectOne(agentId: string): Promise<AgentInstallation> {
    const catalog = await this.catalog();
    const registry = this.registry(catalog);
    const definition = registry.getDefinition(agentId);
    const installation = await registry.getAdapter(agentId).detect({
      definition,
      ...(catalog.manualExecutablePaths[agentId] === undefined
        ? {}
        : { manualExecutablePath: catalog.manualExecutablePaths[agentId] }),
      resolver: this.resolver,
      commandRunner: this.commandRunner,
      timeoutMs: this.timeoutMs,
      now: this.now
    });
    await this.mutateCatalog(async (latest) => {
      return {
        next: {
          ...latest,
          installations: replaceById(latest.installations, installation, (item) => item.agentId),
          updatedAt: this.now()
        },
        result: undefined
      };
    });
    return installation;
  }

  public async setExecutablePath(
    agentId: string,
    executablePath: string
  ): Promise<AgentInstallation> {
    if (!(await this.resolver.validate(executablePath))) {
      throw agentError(
        "AGENT_EXECUTABLE_INVALID",
        "O caminho informado não aponta para um executável válido."
      );
    }
    await this.mutateCatalog(async (catalog) => {
      return {
        next: {
          ...catalog,
          manualExecutablePaths: {
            ...catalog.manualExecutablePaths,
            [agentId]: resolve(executablePath)
          },
          updatedAt: this.now()
        },
        result: undefined
      };
    });
    return this.detectOne(agentId);
  }

  public async clearExecutablePath(agentId: string): Promise<void> {
    await this.mutateCatalog(async (catalog) => {
      const paths = Object.fromEntries(
        Object.entries(catalog.manualExecutablePaths).filter(([id]) => id !== agentId)
      );
      return {
        next: { ...catalog, manualExecutablePaths: paths, updatedAt: this.now() },
        result: undefined
      };
    });
  }

  public async savePreset(input: AgentPreset): Promise<AgentPreset> {
    const preset = agentPresetSchema.parse(input);
    return this.mutateCatalog(async (catalog) => {
      const registry = this.registry(catalog);
      await registry.getAdapter(preset.agentId).validateConfiguration(preset);
      if (preset.isBuiltIn && catalog.presets.some((item) => item.id === preset.id)) {
        throw agentError(
          "AGENT_CONFIGURATION_INVALID",
          "Presets internos não podem ser alterados destrutivamente."
        );
      }
      return {
        next: {
          ...catalog,
          presets: replaceById(catalog.presets, preset, (item) => item.id),
          updatedAt: this.now()
        },
        result: preset
      };
    });
  }

  public async createPreset(
    input: Omit<AgentPreset, "id" | "isBuiltIn" | "createdAt" | "updatedAt">
  ): Promise<AgentPreset> {
    const now = this.now();
    return this.savePreset(
      agentPresetSchema.parse({
        ...input,
        id: `preset-${randomUUID().replaceAll("-", "")}`,
        isBuiltIn: false,
        createdAt: now,
        updatedAt: now
      })
    );
  }

  public async deletePreset(presetId: string): Promise<void> {
    await this.mutateCatalog(async (catalog) => {
      const preset = catalog.presets.find((item) => item.id === presetId);
      if (preset?.isBuiltIn)
        throw agentError(
          "AGENT_CONFIGURATION_INVALID",
          "Presets internos não podem ser excluídos."
        );
      return {
        next: {
          ...catalog,
          presets: catalog.presets.filter((item) => item.id !== presetId),
          updatedAt: this.now()
        },
        result: undefined
      };
    });
  }

  public async saveRole(input: AgentRole): Promise<AgentRole> {
    const role = agentRoleSchema.parse({ ...input, revision: roleRevision(input.instructions) });
    return this.mutateCatalog(async (catalog) => {
      const existing = catalog.roles.find((item) => item.id === role.id);
      if (existing?.source === "built-in") {
        throw agentError(
          "ROLE_INVALID",
          "Responsabilidades internas não podem ser alteradas; duplique-as primeiro."
        );
      }
      return {
        next: {
          ...catalog,
          roles: replaceById(catalog.roles, role, (item) => item.id),
          updatedAt: this.now()
        },
        result: role
      };
    });
  }

  public async createRole(input: {
    readonly name: string;
    readonly description?: string;
    readonly instructions: string;
    readonly badge?: AgentRole["badge"];
  }): Promise<AgentRole> {
    const now = this.now();
    return this.saveRole(
      agentRoleSchema.parse({
        id: `role-${randomUUID().replaceAll("-", "")}`,
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.badge === undefined ? {} : { badge: input.badge }),
        instructions: input.instructions,
        revision: roleRevision(input.instructions),
        source: "user",
        scope: "global",
        portable: false,
        createdAt: now,
        updatedAt: now
      })
    );
  }

  public async duplicateRole(roleId: string): Promise<AgentRole> {
    const catalog = await this.catalog();
    const source = this.requireRole(catalog, roleId);
    const now = this.now();
    const role = agentRoleSchema.parse({
      ...source,
      id: `role-${randomUUID().replaceAll("-", "")}`,
      name: `${source.name} (cópia)`,
      source: "user",
      scope: "global",
      portable: false,
      createdAt: now,
      updatedAt: now
    });
    return this.saveRole(role);
  }

  public async deleteRole(roleId: string): Promise<void> {
    await this.mutateCatalog(async (catalog) => {
      const role = this.requireRole(catalog, roleId);
      if (role.source === "built-in")
        throw agentError("ROLE_INVALID", "Responsabilidades internas não podem ser excluídas.");
      return {
        next: {
          ...catalog,
          roles: catalog.roles.filter((item) => item.id !== roleId),
          updatedAt: this.now()
        },
        result: undefined
      };
    });
  }

  public async importRepositoryRoles(
    workspaceDirectory: string,
    roleIds?: readonly string[]
  ): Promise<readonly AgentRole[]> {
    const found = await new PortableRoleService().discover(workspaceDirectory);
    const selected =
      roleIds === undefined ? found : found.filter((role) => roleIds.includes(role.id));
    return this.mutateCatalog(async (catalog) => {
      for (const role of selected) {
        if (
          catalog.roles.some(
            (existing) => existing.id === role.id && existing.revision !== role.revision
          )
        ) {
          throw agentError(
            "ROLE_IMPORT_CONFLICT",
            `Já existe uma responsabilidade diferente com o ID ${role.id}.`
          );
        }
      }
      return {
        next: {
          ...catalog,
          roles: mergeById(catalog.roles, selected, (item) => item.id),
          updatedAt: this.now()
        },
        result: selected
      };
    });
  }

  public async discoverRepositoryRoles(workspaceDirectory: string): Promise<readonly AgentRole[]> {
    return new PortableRoleService().discover(workspaceDirectory);
  }

  public async exportRole(workspaceDirectory: string, roleId: string): Promise<void> {
    const catalog = await this.catalog();
    await new PortableRoleService().export(workspaceDirectory, this.requireRole(catalog, roleId));
  }

  public async resolveLaunch(
    request: AgentLaunchRequest,
    permissionPolicy: WorkspacePermissionPolicy,
    sessionId: string
  ): Promise<AgentLaunchResolution> {
    return this.resolveLaunchMode(request, permissionPolicy, sessionId, "interactive");
  }

  public async resolveTaskLaunch(
    request: AgentLaunchRequest,
    permissionPolicy: WorkspacePermissionPolicy,
    sessionId: string
  ): Promise<AgentLaunchResolution> {
    return this.resolveLaunchMode(request, permissionPolicy, sessionId, "task");
  }

  private async resolveLaunchMode(
    request: AgentLaunchRequest,
    permissionPolicy: WorkspacePermissionPolicy,
    sessionId: string,
    mode: "interactive" | "task"
  ): Promise<AgentLaunchResolution> {
    const catalog = await this.catalog();
    const registry = this.registry(catalog);
    const definition = registry.getDefinition(request.agentId);
    const preset =
      request.presetId === undefined
        ? undefined
        : catalog.presets.find((item) => item.id === request.presetId);
    if (
      request.presetId !== undefined &&
      (preset === undefined || preset.agentId !== request.agentId)
    ) {
      throw agentError(
        "AGENT_CONFIGURATION_INVALID",
        "O preset não pertence ao agente selecionado."
      );
    }
    const installation = await this.detectOne(request.agentId);
    const roleId = request.roleId ?? preset?.roleId;
    if (roleId !== undefined && !definition.supportsRoles) {
      throw agentError(
        "AGENT_CONFIGURATION_INVALID",
        `${definition.name} não aceita responsabilidades.`,
        "Escolha um agente compatível ou remova a responsabilidade."
      );
    }
    const rolePreparation =
      roleId === undefined
        ? undefined
        : await this.options.roleInjection.prepare({
            workspaceId: request.workspaceId,
            terminalNodeId: request.terminalNodeId,
            sessionId,
            role: this.requireRole(catalog, roleId)
          });
    try {
      const adapter = registry.getAdapter(request.agentId);
      const adapterInput: AdapterLaunchInput = {
        definition,
        installation,
        ...(preset === undefined ? {} : { preset }),
        request,
        processEnvironment: compactEnvironment(this.environment),
        resolver: this.resolver,
        ...(rolePreparation === undefined
          ? {}
          : {
              rolePreparation:
                request.agentId === "custom"
                  ? { ...rolePreparation, initialInput: "" }
                  : rolePreparation
            }),
        permissionPolicy
      };
      const resolved = await (mode === "task" && adapter.resolveTaskLaunch !== undefined
        ? adapter.resolveTaskLaunch(adapterInput)
        : adapter.resolveLaunch(adapterInput));
      return {
        agentId: request.agentId,
        ...(preset === undefined ? {} : { presetId: preset.id }),
        ...(rolePreparation === undefined
          ? {}
          : {
              rolePreparation:
                request.agentId === "custom"
                  ? { ...rolePreparation, initialInput: "" }
                  : rolePreparation
            }),
        ...(permissionPolicy.fileAccess === "ask" &&
        permissionPolicy.networkAccess === "agent-default"
          ? {}
          : {
              permissionNotice:
                "A política é persistida e aplicada ao diretório de trabalho; CLIs externas podem exigir configuração própria."
            }),
        launch: {
          executable: {
            path: resolved.executable,
            kind: /\.(cmd|bat)$/i.test(resolved.executable) ? "command-shim" : "native"
          },
          args: resolved.args,
          ...(resolved.windowsVerbatimArguments === undefined
            ? {}
            : { windowsVerbatimArguments: resolved.windowsVerbatimArguments }),
          cwd: request.workingDirectory,
          environment: resolved.environment,
          cols: 100,
          rows: 30,
          transport: resolved.processMode
        }
      };
    } catch (error) {
      if (rolePreparation !== undefined) await this.options.roleInjection.cleanup(sessionId);
      throw error;
    }
  }

  public cleanupRole(sessionId: string): Promise<void> {
    return this.options.roleInjection.cleanup(sessionId);
  }

  private async catalog(): Promise<AgentCatalog> {
    return agentCatalogSchema.parse(await this.options.store.loadAgentCatalog());
  }

  private async mutateCatalog<T>(
    operation: (
      catalog: AgentCatalog
    ) => Promise<{ readonly next: AgentCatalog; readonly result: T }>
  ): Promise<T> {
    const previous = this.catalogMutationTail;
    let release!: () => void;
    this.catalogMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const { next, result } = await operation(await this.catalog());
      await this.options.store.saveAgentCatalog(agentCatalogSchema.parse(next));
      return result;
    } finally {
      release();
    }
  }

  private registry(catalog: AgentCatalog): AgentRegistry {
    return new AgentRegistry(
      [...createBuiltInAgentDefinitions(this.now()), ...catalog.customDefinitions],
      createAdapters()
    );
  }

  private requireRole(catalog: AgentCatalog, roleId: string): AgentRole {
    const role = catalog.roles.find((item) => item.id === roleId);
    if (role === undefined)
      throw agentError("ROLE_NOT_FOUND", "A responsabilidade selecionada não existe.");
    return role;
  }
}

export type AgentAvailabilityState =
  "available" | "not-installed" | "not-authenticated" | "executable-invalid" | "spawn-failed";

export interface AgentAvailability {
  readonly provider: string;
  readonly available: boolean;
  readonly state: AgentAvailabilityState;
  readonly installation: AgentInstallation;
  readonly executableResolution: string | null;
  readonly authState: "authenticated" | "required" | "unknown";
}

/** Cheap, repeatable provider preflight used before a provider can become a team worker. */
export class AgentAvailabilityService {
  public constructor(private readonly runtime: Pick<AgentRuntime, "detectOne">) {}

  public async check(provider: string): Promise<AgentAvailability> {
    const installation = await this.runtime.detectOne(provider);
    const state: AgentAvailabilityState =
      installation.status === "installed"
        ? "available"
        : installation.status === "not-installed"
          ? "not-installed"
          : installation.status === "not-authenticated"
            ? "not-authenticated"
            : installation.error?.code === "AGENT_SPAWN_FAILED"
              ? "spawn-failed"
              : "executable-invalid";
    return {
      provider,
      available: state === "available",
      state,
      installation,
      executableResolution: installation.executablePath ?? null,
      authState:
        state === "available"
          ? "authenticated"
          : state === "not-authenticated"
            ? "required"
            : "unknown"
    };
  }
}

function createAdapters(): readonly AgentAdapter[] {
  return [
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
    new OpenCodeAdapter(),
    new ShellAdapter(),
    new CustomCommandAdapter()
  ];
}

function compactEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !nestedAgentControlVariables.has(entry[0].toUpperCase())
    )
  );
}

/** Host-only controls must not silently restrict or attach a nested provider session. */
const nestedAgentControlVariables = new Set([
  "CODEX_PERMISSION_PROFILE",
  "CODEX_THREAD_ID",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_SHELL"
]);

function executableNames(
  candidate: string,
  pathExt: string | undefined,
  platform: NodeJS.Platform
): readonly string[] {
  if (platform !== "win32" || /\.[A-Za-z0-9]+$/.test(candidate)) return [candidate];
  const configured = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  const ordered = [".exe", ".cmd", ".bat", ".com", ...configured];
  return [...new Set(ordered)].map((extension) => `${candidate}${extension}`);
}

function isWindowsLaunchablePath(path: string): boolean {
  return /\.(?:com|exe|bat|cmd)$/i.test(path);
}

function firstMeaningfulLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 240);
}

function isAuthenticationFailure(value: string): boolean {
  return /(authentication required|not authenticated|authenticate|authorization required|login|sign[ -]?in|(?:api[ _-]?key|token|credential).*(?:required|missing|invalid))/i.test(
    value
  );
}

function agentError(
  code: AgentErrorCode,
  message: string,
  suggestedAction?: string,
  cause?: unknown
): AgentOperationError {
  return new AgentOperationError(
    { code, message, ...(suggestedAction === undefined ? {} : { suggestedAction }) },
    { ...(cause === undefined ? {} : { cause }) }
  );
}

function replaceById<T>(items: readonly T[], next: T, id: (item: T) => string): T[] {
  const found = items.some((item) => id(item) === id(next));
  return found ? items.map((item) => (id(item) === id(next) ? next : item)) : [...items, next];
}

function mergeById<T>(left: readonly T[], right: readonly T[], id: (item: T) => string): T[] {
  return right.reduce<T[]>((items, item) => replaceById(items, item, id), [...left]);
}

function safeRoleDirectory(root: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || basename(name) !== name) {
    throw agentError("ROLE_INVALID", "O ID da responsabilidade contém um caminho inválido.");
  }
  const directory = resolve(root, name);
  const relation = relative(root, directory);
  if (
    relation === ".." ||
    relation.startsWith(`..${String.fromCharCode(92)}`) ||
    isAbsolute(relation)
  ) {
    throw agentError("ROLE_INVALID", "A responsabilidade tentou sair do diretório permitido.");
  }
  return directory;
}

function isBadge(
  value: unknown
): value is { readonly label: string; readonly colorToken?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "label" in value &&
    typeof value.label === "string"
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
