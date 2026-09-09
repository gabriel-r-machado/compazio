import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type PortalMcpAgentId = "claude-code" | "codex" | "opencode";

export const portalMcpToolNames = [
  "portal_list",
  "portal_get",
  "portal_dom",
  "portal_accessibility",
  "portal_console",
  "portal_viewport",
  "portal_navigate",
  "portal_back",
  "portal_forward",
  "portal_reload",
  "portal_stop",
  "portal_click",
  "portal_type",
  "portal_press",
  "portal_scroll",
  "portal_focus",
  "portal_screenshot",
  "portal_close"
] as const;

export interface PortalMcpLaunch {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  cleanup(): Promise<void>;
}

/** Only process-scoped configuration is generated. No user MCP configuration is read or mutated. */
export async function createPortalMcpLaunch(input: {
  readonly agentId: PortalMcpAgentId;
  readonly directory: string;
  /** Workspace cwd used by Codex to discover repository-scoped local skills. */
  readonly workingDirectory?: string;
  readonly endpoint?: string;
  readonly token?: string;
  readonly prompt?: string;
  /** Trusted Compazio-only instructions loaded as provider system context. */
  readonly orchestratorInstructionsPath?: string;
  readonly orchestratorInstructions?: string;
  /** Interactive launches are used by terminal nodes; non-interactive launches execute hidden tasks. */
  readonly interactive?: boolean;
  /** A bounded worker turn may edit only its current workspace and still exit deterministically. */
  readonly workspaceAccess?: "read" | "write";
  /** The adapter receives only capabilities granted by the canvas connection. */
  /** Tool names are capability-scoped by the trusted gateway; this module never decides grants. */
  readonly tools?: readonly string[];
}): Promise<PortalMcpLaunch> {
  const tools = input.tools ?? [];
  const hasMcp = input.endpoint !== undefined && input.token !== undefined && tools.length > 0;
  if (input.agentId === "claude-code") {
    const path = join(input.directory, "compazio-mcp.json");
    if (hasMcp) {
      await writeFile(
        path,
        JSON.stringify({
          mcpServers: {
            compazio: {
              type: "streamable-http",
              url: input.endpoint,
              headers: { Authorization: "Bearer ${COMPAZIO_MCP_TOKEN}" }
            }
          }
        }),
        "utf8"
      );
      await chmod(path, 0o600).catch(() => undefined);
    }
    return {
      args: [
        // Compazio owns the canvas control plane. Host-global skills must not introduce a second
        // orchestration surface into either an interactive terminal or an unattended agent turn.
        "--disable-slash-commands",
        ...(input.interactive === true
          ? []
          : ["--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence"]),
        ...(hasMcp
          ? [
              "--mcp-config",
              path,
              // The canvas edge is the user's explicit authorization. Grant only those exact MCP
              // tools so an unattended request never stalls on a provider permission dialog.
              "--allowedTools",
              tools.map((tool) => `mcp__compazio__${tool}`).join(",")
            ]
          : []),
        ...(input.orchestratorInstructionsPath === undefined
          ? []
          : ["--append-system-prompt-file", input.orchestratorInstructionsPath]),
        // Claude's --mcp-config is variadic. Without the explicit option terminator, a positional
        // prompt is parsed as another configuration path on current native Windows builds.
        ...(input.prompt === undefined ? [] : ["--", input.prompt])
      ],
      environment: hasMcp ? { COMPAZIO_MCP_TOKEN: input.token ?? "" } : {},
      cleanup: async () => {
        await rm(path, { force: true });
      }
    };
  }
  if (input.agentId === "codex") {
    const skillIsolationDirectory = await mkdtemp(join(input.directory, "codex-skills-"));
    let localSkillIsolationArgs: readonly string[];
    try {
      localSkillIsolationArgs = await buildCodexLocalSkillIsolationArgs({
        workingDirectory: input.workingDirectory ?? process.cwd(),
        aliasDirectory: skillIsolationDirectory
      });
    } catch (error) {
      await rm(skillIsolationDirectory, { force: true, recursive: true });
      throw error;
    }
    // Invocation-scoped overrides add Compazio without replacing the user's profile, sandbox or
    // approval policy.
    return {
      args: [
        ...(input.interactive === true
          ? []
          : ["exec", "--json", "--ephemeral", "--skip-git-repo-check"]),
        ...(hasMcp
          ? [
              "-c",
              `mcp_servers.compazio.url=${JSON.stringify(input.endpoint)}`,
              "-c",
              'mcp_servers.compazio.bearer_token_env_var="COMPAZIO_MCP_TOKEN"',
              "-c",
              `mcp_servers.compazio.enabled_tools=${JSON.stringify(tools)}`,
              "-c",
              // The connection already grants an exact allow-list. Auto-approve only those tools
              // on this ephemeral server; shell/sandbox and every user setting remain unchanged.
              'mcp_servers.compazio.default_tools_approval_mode="approve"',
              "-c",
              "mcp_servers.compazio.startup_timeout_sec=20",
              "-c",
              "mcp_servers.compazio.tool_timeout_sec=30"
            ]
          : []),
        ...(input.orchestratorInstructions === undefined
          ? []
          : ["-c", `developer_instructions=${JSON.stringify(input.orchestratorInstructions)}`]),
        ...localSkillIsolationArgs,
        ...(input.prompt === undefined ? [] : [input.prompt])
      ],
      environment: hasMcp ? { COMPAZIO_MCP_TOKEN: input.token ?? "" } : {},
      cleanup: async () => {
        await rm(skillIsolationDirectory, { force: true, recursive: true });
      }
    };
  }

  // OPENCODE_CONFIG is the cross-platform, process-scoped override. It retains the user's
  // authenticated provider profile while keeping this MCP server isolated to the terminal.
  const configPath = join(input.directory, "opencode-mcp.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        ...(input.orchestratorInstructionsPath === undefined
          ? {}
          : {
              instructions: [input.orchestratorInstructionsPath]
            }),
        ...(hasMcp
          ? {
              mcp: {
                compazio: {
                  type: "remote",
                  url: input.endpoint,
                  enabled: true,
                  codemode: false,
                  headers: { Authorization: "Bearer {env:COMPAZIO_MCP_TOKEN}" }
                }
              }
            }
          : {})
      },
      null,
      2
    ),
    "utf8"
  );
  await chmod(configPath, 0o600).catch(() => undefined);
  return {
    args:
      input.interactive === true
        ? []
        : ["run", "--format", "json", ...(input.prompt === undefined ? [] : [input.prompt])],
    environment: {
      ...(hasMcp ? { COMPAZIO_MCP_TOKEN: input.token ?? "" } : {}),
      OPENCODE_CONFIG: configPath
    },
    cleanup: async () => {
      await rm(configPath, { force: true });
    }
  };
}

/**
 * Codex discovers user and repository skills before the first turn. Compazio owns the canvas
 * control plane, so a terminal launched here must not inherit a second local orchestration layer.
 * The override is invocation-scoped: it never edits the user's config, auth, model or sandbox.
 */
export async function buildCodexLocalSkillIsolationArgs(input: {
  readonly workingDirectory: string;
  readonly aliasDirectory: string;
  readonly homeDirectory?: string;
}): Promise<readonly string[]> {
  const roots = new Set<string>([join(input.homeDirectory ?? homedir(), ".agents", "skills")]);
  let current = resolve(input.workingDirectory);
  for (;;) {
    roots.add(join(current, ".agents", "skills"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const skillFiles = new Set<string>();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = join(root, entry.name, "SKILL.md");
      try {
        if ((await stat(candidate)).isFile()) skillFiles.add(resolve(candidate));
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }
  }

  if (skillFiles.size === 0) return [];
  await mkdir(input.aliasDirectory, { recursive: true });
  const aliases: string[] = [];
  for (const [index, skillFile] of [...skillFiles]
    .sort((left, right) => left.localeCompare(right))
    .entries()) {
    const alias = join(input.aliasDirectory, `skill-${String(index + 1).padStart(3, "0")}`);
    await symlink(dirname(skillFile), alias, process.platform === "win32" ? "junction" : "dir");
    aliases.push(join(alias, "SKILL.md"));
  }
  const entries = aliases.map(
    (path) => `{path=${JSON.stringify(path.replaceAll("\\", "/"))},enabled=false}`
  );
  return ["-c", `skills.config=[${entries.join(",")}]`];
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export interface PortalMcpTranscript {
  readonly discovered: boolean;
  readonly calledPortalList: boolean;
  readonly usedForbiddenTool: boolean;
  readonly receivedPortalNotConnected: boolean;
  readonly protocolVersion?: string;
}

/** Conservative parser: it recognizes a real MCP call, never treats final prose as proof. */
export function inspectPortalMcpTranscript(output: string): PortalMcpTranscript {
  const records = output.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
  const discovered = records.some((record) =>
    containsToolName(record, "mcp__compazio__portal_list")
  );
  const calledPortalList = records.some((record) =>
    containsToolUse(record, "mcp__compazio__portal_list")
  );
  const usedForbiddenTool = records.some((record) => containsForbiddenToolUse(record));
  const receivedPortalNotConnected = records.some((record) =>
    containsErrorCode(record, "PORTAL_NOT_CONNECTED")
  );
  const protocolVersion = records
    .map((record) => findProtocolVersion(record))
    .find((value): value is string => value !== undefined);
  return {
    discovered,
    calledPortalList,
    usedForbiddenTool,
    receivedPortalNotConnected,
    ...(protocolVersion === undefined ? {} : { protocolVersion })
  };
}

function containsToolName(value: unknown, toolName: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsToolName(entry, toolName));
  if (!isRecord(value)) return false;
  const configuredName = toolName.replace(/^mcp__compazio__/, "");
  return (
    value.name === toolName ||
    value.tool === configuredName ||
    Object.values(value).some((entry) => containsToolName(entry, toolName))
  );
}

function containsToolUse(value: unknown, toolName: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsToolUse(entry, toolName));
  if (!isRecord(value)) return false;
  const type = typeof value.type === "string" ? value.type : "";
  const configuredName = toolName.replace(/^mcp__compazio__/, "");
  if (
    ["tool_use", "mcp_tool_call", "tool_call", "tool"].includes(type) &&
    (value.name === toolName || value.tool === configuredName)
  )
    return true;
  return Object.values(value).some((entry) => containsToolUse(entry, toolName));
}

function containsForbiddenToolUse(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenToolUse);
  if (!isRecord(value)) return false;
  const type = typeof value.type === "string" ? value.type : "";
  const name = typeof value.name === "string" ? value.name : "";
  if (["command_execution", "shell_command"].includes(type)) return true;
  if (
    ["tool_use", "mcp_tool_call", "tool_call", "tool"].includes(type) &&
    /^(?:Bash|Read|Write|Edit|Git|PowerShell|cmd|shell)$/i.test(name || type)
  )
    return true;
  return Object.values(value).some(containsForbiddenToolUse);
}

function containsErrorCode(value: unknown, code: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsErrorCode(entry, code));
  if (!isRecord(value)) return false;
  if (value.code === code) return true;
  return Object.values(value).some((entry) => containsErrorCode(entry, code));
}

export function safePortalMcpDebugEvents(output: string): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of output.split(/\r?\n/)) {
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(record) || typeof record.type !== "string") continue;
    if (record.type === "system" && record.subtype === "init") {
      events.push({
        type: "system.init",
        mcpServers: record.mcp_servers,
        mcpServerErrors: record.mcp_server_errors
      });
      continue;
    }
    if (record.type === "assistant") {
      const tools = extractToolUses(record);
      if (tools.length > 0) events.push({ type: "assistant.tool_use", tools });
      continue;
    }
    if (
      (record.type === "item.started" || record.type === "item.completed") &&
      isRecord(record.item) &&
      record.item.type === "mcp_tool_call"
    ) {
      events.push({
        type: "codex.mcp_tool_call",
        tool: record.item.tool,
        status: record.item.status,
        error: record.item.error
      });
      continue;
    }
    if (record.type === "result") {
      events.push({
        type: "result",
        isError: record.is_error === true,
        terminalReason: record.terminal_reason,
        error: record.error,
        ...(typeof record.result === "string" ? { result: record.result.slice(0, 500) } : {})
      });
    }
  }
  return events;
}

export function safePortalMcpFailureExcerpt(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => /error|invalid|unknown|failed|mcp|config/i.test(line))
    .map((line) => line.replace(/[A-Za-z]:\\Users\\[^\s]+/g, "[LOCAL_PATH]"))
    .slice(-12)
    .join("\n")
    .slice(0, 2000);
}

function extractToolUses(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(extractToolUses);
  if (!isRecord(value)) return [];
  const current =
    ["tool_use", "mcp_tool_call", "tool_call"].includes(String(value.type)) &&
    typeof value.name === "string"
      ? [value.name]
      : [];
  return [...current, ...Object.values(value).flatMap(extractToolUses)];
}

function findProtocolVersion(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findProtocolVersion(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.protocolVersion === "string") return value.protocolVersion;
  for (const entry of Object.values(value)) {
    const found = findProtocolVersion(entry);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function buildPortalListPrompt(): string {
  return [
    "Use exclusivamente a ferramenta MCP portal_list do servidor Compazio.",
    "Liste os Portais disponíveis e informe o título e o identificador do Portal conectado.",
    "Não use Bash, terminal, shell, filesystem, Git ou navegador externo."
  ].join(" ");
}

export function buildPortalFlowPrompt(input: {
  readonly portalId: string;
  readonly url: string;
  readonly connectedMedia?: {
    readonly imageId: string;
    readonly pdfId: string;
    readonly noteId: string;
  };
}): string {
  const media = input.connectedMedia;
  return [
    `Use exclusivamente as ferramentas MCP portal_*${media === undefined ? "" : ", context_read e note_update"} do servidor Compazio. Não use Bash, shell, terminal, filesystem, Git ou navegador externo.`,
    `O Portal autorizado tem o id ${input.portalId}. Execute cada passo nesta ordem e somente finalize depois de todos:`,
    "1. Use portal_list.",
    `2. Use portal_navigate para abrir ${input.url}.`,
    "3. Use portal_click com role button e name Incrementar.",
    "4. Use portal_type com label Nome, text Compazio Agent Test e clear true.",
    "5. Use portal_click com role button e name Enviar.",
    "6. Use portal_dom e portal_accessibility.",
    "7. Use portal_click com role button e name Console log e depois portal_console.",
    "8. Use portal_screenshot.",
    ...(media === undefined
      ? []
      : [
          `9. Use context_read na imagem ${media.imageId} e no PDF ${media.pdfId}.`,
          `10. Use note_update em ${media.noteId}, mode replace, registrando o texto principal visível na imagem e o código exato extraído do PDF. Não adivinhe nem use o caminho do arquivo.`
        ]),
    "Informe somente um resumo curto das ações concluídas."
  ].join(" ");
}

export function buildPortalDeniedPrompt(input: { readonly portalId: string }): string {
  return [
    "Use exclusivamente a ferramenta MCP portal_navigate do servidor Compazio.",
    `Tente navegar o Portal ${input.portalId} para http://127.0.0.1/.`,
    "Não use Bash, shell, terminal, filesystem, Git ou navegador externo."
  ].join(" ");
}
