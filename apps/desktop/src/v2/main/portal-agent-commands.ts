import type { PortalAgentId } from "./portal-agent-harness";

export interface PortalAgentCommandOptions {
  readonly executable: string;
  readonly workingDirectory: string;
  /** OpenCode only: the harness may pin a provider/model for the run without touching user config. */
  readonly model?: string;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface PortalAgentCommand {
  readonly executable: string;
  readonly args: readonly string[];
  /** When true the prompt goes to stdin; otherwise it is the last argument. */
  readonly promptOnStdin: boolean;
  readonly closeStdin: boolean;
}

export interface PortalAgentVersionCommand {
  readonly args: readonly string[];
}

export interface PortalAgentAuthCommand {
  readonly args: readonly string[];
  /** Exit code zero is not always enough: Codex prints its status on a successful exit. */
  readonly expect?: RegExp;
  readonly reject?: RegExp;
}

/**
 * The harness speaks the same dialect as the production adapters: `--print` for Claude Code,
 * `exec --json --sandbox` for Codex, `run` for OpenCode. Diverging here would test a command the
 * product never issues.
 */
export function buildPortalAgentCommand(
  agentId: PortalAgentId,
  options: PortalAgentCommandOptions
): PortalAgentCommand {
  if (agentId === "claude-code")
    return {
      executable: options.executable,
      args: [
        "--print",
        "--output-format",
        "json",
        // The installed CLI documents the pattern as `Bash(git *)`: space, not colon. Only the
        // Portal subcommands are granted — no edits, no Git, no arbitrary process.
        "--allowedTools",
        "Bash(compazio portal *)",
        "--permission-mode",
        "acceptEdits"
      ],
      // The shim only launches under a PTY, and a PTY stdin is a TTY: `--print` then refuses to
      // read a prompt from it. The instruction therefore travels as an argument.
      promptOnStdin: false,
      closeStdin: true
    };
  if (agentId === "codex")
    return {
      executable: options.executable,
      args: [
        "exec",
        "--json",
        // The current environment refuses to run outside a Git repository without this.
        "--skip-git-repo-check",
        "--sandbox",
        options.sandbox ?? "workspace-write",
        "--cd",
        options.workingDirectory
      ],
      // Same reason as Claude Code: `codex exec -` would wait on a stdin that never closes here.
      promptOnStdin: false,
      closeStdin: true
    };
  return {
    executable: options.executable,
    args: ["run", ...(options.model === undefined ? [] : ["--model", options.model])],
    promptOnStdin: false,
    closeStdin: true
  };
}

export function buildPortalAgentVersionCommand(agentId: PortalAgentId): PortalAgentVersionCommand {
  return { args: agentId === "codex" ? ["--version"] : ["--version"] };
}

/**
 * Authentication is asked of the agent itself, never inferred from a config file: a stale token on
 * disk would make the probe claim a login the provider does not honour.
 */
export function buildPortalAgentAuthCommand(agentId: PortalAgentId): PortalAgentAuthCommand | null {
  if (agentId === "codex") return { args: ["login", "status"], reject: /not logged in/i };
  if (agentId === "claude-code") return null;
  return null;
}

/** OpenCode names a model as `provider/model`; anything else would reach the wrong endpoint. */
export function isValidOpenCodeModel(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/.test(value);
}
