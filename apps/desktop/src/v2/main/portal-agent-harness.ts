export type PortalAgentId = "claude-code" | "codex" | "opencode";

export type PortalAgentStatus =
  "passed" | "failed" | "blocked-external" | "not-installed" | "not-authenticated";

export type PortalAgentFailureCategory =
  "agent" | "authentication" | "provider" | "bridge" | "portal" | "timeout" | "cleanup";

export interface PortalAgentSteps {
  readonly listPortal: boolean;
  readonly navigate: boolean;
  readonly click: boolean;
  readonly type: boolean;
  readonly submit: boolean;
  readonly readResult: boolean;
  readonly screenshot: boolean;
  readonly console: boolean;
  readonly revokedAfterDisconnect: boolean;
  readonly cleanup: boolean;
}

export interface RealPortalAgentProbe {
  readonly agentId: PortalAgentId;
  readonly version?: string;
  readonly status: PortalAgentStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly steps: PortalAgentSteps;
  readonly failure?: {
    readonly category: PortalAgentFailureCategory;
    readonly code?: string;
    readonly message: string;
  };
}

export interface PortalAgentAvailability {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly version?: string;
  readonly issue?: string;
}

export interface PortalAgentTurn {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/** What the fixture and the runtime actually show after the agent's turn. */
export interface PortalAgentObservation {
  readonly counter: number;
  readonly nameValue: string;
  readonly visibleResult: string;
  readonly navigatedUrl: string;
  readonly screenshotCount: number;
  readonly consoleEntries: number;
  readonly listedByAgent: boolean;
}

export interface PortalAgentRevocation {
  readonly attempted: boolean;
  readonly code: string;
  readonly fixtureUnchanged: boolean;
}

export interface PortalAgentCleanup {
  readonly views: number;
  readonly webContents: number;
  readonly listeners: number;
  readonly pendingOperations: number;
  readonly screenshots: number;
  readonly agentProcesses: number;
  readonly temporaryRemoved: boolean;
}

/**
 * Everything the probe needs from the outside world. The real implementation lives in Electron and
 * talks to the actual runtime; the tests provide a fake one, which is what lets the harness be
 * verified in CI on a machine where no agent CLI is installed.
 */
export interface PortalAgentEnvironment {
  detect(): Promise<PortalAgentAvailability>;
  runTurn(prompt: string): Promise<PortalAgentTurn>;
  observe(): Promise<PortalAgentObservation>;
  revoke(): Promise<PortalAgentRevocation>;
  cleanup(): Promise<PortalAgentCleanup>;
}

export interface PortalAgentProbeOptions {
  readonly fixtureUrl: string;
  readonly portalId: string;
  readonly expectedName?: string;
  readonly now?: () => number;
}

export const portalAgentExpectedName = "Compazio Agent Test";

const emptySteps: PortalAgentSteps = {
  listPortal: false,
  navigate: false,
  click: false,
  type: false,
  submit: false,
  readResult: false,
  screenshot: false,
  console: false,
  revokedAfterDisconnect: false,
  cleanup: false
};

/**
 * The instruction is deliberately mechanical. The probe never grades prose: it reads the agent's
 * JSON when there is one and, either way, checks what actually happened in the page, in the runtime
 * and on disk.
 */
export function buildPortalAgentPrompt(options: PortalAgentProbeOptions): string {
  const name = options.expectedName ?? portalAgentExpectedName;
  // One line on purpose: the prompt travels as an argv element through a Windows `.cmd` shim, and
  // a newline there is a command separator, not text.
  return [
    "Você está em um teste automatizado do Compazio.",
    "Use somente a CLI `compazio portal`.",
    "1. Liste os Portais: compazio portal list.",
    `2. Navegue o Portal ${options.portalId} até ${options.fixtureUrl}.`,
    `3. Clique uma vez no botão Incrementar usando papel e nome acessível.`,
    `4. Limpe o campo Nome e digite ${name}.`,
    "5. Envie o formulário clicando no botão Enviar.",
    "6. Leia o resultado visível na página.",
    "7. Capture uma screenshot.",
    "8. Consulte as mensagens de console.",
    "9. Responda um JSON com portalId, counter, submittedName, visibleResult, screenshotCreated e consoleRead.",
    "Não altere arquivos, não use navegador externo e não use comandos fora da CLI do Compazio."
  ].join(" ");
}

export interface PortalAgentReport {
  readonly portalId?: string;
  readonly counter?: number;
  readonly submittedName?: string;
  readonly visibleResult?: string;
  readonly screenshotCreated?: boolean;
  readonly consoleRead?: boolean;
}

/**
 * Agents wrap JSON in prose, fences and log lines. The last balanced object that carries any of the
 * expected keys wins; when there is none the probe simply falls back to observed effects.
 */
export function extractPortalAgentReport(output: string): PortalAgentReport | null {
  const candidates: string[] = [];
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = index; cursor < output.length; cursor += 1) {
      const character = output[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') inString = !inString;
      if (inString) continue;
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(output.slice(index, cursor + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const value = parsed as Record<string, unknown>;
    const keys = [
      "portalId",
      "counter",
      "submittedName",
      "visibleResult",
      "screenshotCreated",
      "consoleRead"
    ];
    if (!keys.some((key) => key in value)) continue;
    return {
      ...(typeof value.portalId === "string" ? { portalId: value.portalId } : {}),
      ...(Number.isFinite(Number(value.counter)) ? { counter: Number(value.counter) } : {}),
      ...(typeof value.submittedName === "string" ? { submittedName: value.submittedName } : {}),
      ...(typeof value.visibleResult === "string" ? { visibleResult: value.visibleResult } : {}),
      ...(typeof value.screenshotCreated === "boolean"
        ? { screenshotCreated: value.screenshotCreated }
        : {}),
      ...(typeof value.consoleRead === "boolean" ? { consoleRead: value.consoleRead } : {})
    };
  }
  return null;
}

const providerPatterns: readonly RegExp[] = [
  /error from provider/i,
  /upstream request failed/i,
  /provider .*(unavailable|error|failed)/i,
  /model .*(not found|unavailable|unsupported)/i,
  /rate.?limit/i,
  /(502|503|504)\s+(bad gateway|service unavailable|gateway timeout)/i,
  /overloaded/i,
  /insufficient (quota|credits)/i
];

const authenticationPatterns: readonly RegExp[] = [
  /not logged in/i,
  /please (run )?`?(claude|codex|opencode)? ?login/i,
  /authentication (failed|required)/i,
  /unauthorized/i,
  /invalid api key/i,
  /401/
];

/**
 * A provider that is down is not a Compazio defect, and neither is a missing login. Separating the
 * two from a real failure of the bridge or the Portal is the whole point of running this by agent.
 */
export function classifyPortalAgentFailure(
  turn: Pick<PortalAgentTurn, "stdout" | "stderr" | "timedOut" | "exitCode">
): { readonly category: PortalAgentFailureCategory; readonly code?: string } | null {
  if (turn.timedOut) return { category: "timeout", code: "AGENT_TIMEOUT" };
  const text = `${turn.stdout}\n${turn.stderr}`;
  if (providerPatterns.some((pattern) => pattern.test(text)))
    return { category: "provider", code: "EXTERNAL_PROVIDER_UNAVAILABLE" };
  if (authenticationPatterns.some((pattern) => pattern.test(text)))
    return { category: "authentication", code: "AGENT_NOT_AUTHENTICATED" };
  const portalCode = /PORTAL_[A-Z_]+/.exec(text)?.[0];
  if (portalCode !== undefined && portalCode !== "PORTAL_NOT_CONNECTED")
    return { category: "portal", code: portalCode };
  if (/BRIDGE_[A-Z_]+|ECONNREFUSED|bridge/i.test(text))
    return { category: "bridge", code: /BRIDGE_[A-Z_]+/.exec(text)?.[0] ?? "BRIDGE_UNAVAILABLE" };
  if (turn.exitCode !== 0) return { category: "agent", code: `EXIT_${turn.exitCode ?? "SIGNAL"}` };
  return null;
}

function cleanupOk(cleanup: PortalAgentCleanup): boolean {
  return (
    cleanup.views === 0 &&
    cleanup.webContents === 0 &&
    cleanup.listeners === 0 &&
    cleanup.pendingOperations === 0 &&
    cleanup.screenshots === 0 &&
    cleanup.agentProcesses === 0 &&
    cleanup.temporaryRemoved
  );
}

/**
 * Runs one agent through the Portal flow and answers with data. Cleanup always runs, including
 * after a failed turn, because a harness that leaks on failure is worse than no harness.
 */
export async function runPortalAgentProbe(
  agentId: PortalAgentId,
  environment: PortalAgentEnvironment,
  options: PortalAgentProbeOptions
): Promise<RealPortalAgentProbe> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const expectedName = options.expectedName ?? portalAgentExpectedName;
  let steps: PortalAgentSteps = emptySteps;

  const finish = (
    status: PortalAgentStatus,
    failure?: RealPortalAgentProbe["failure"]
  ): RealPortalAgentProbe => {
    const completedAt = now();
    return {
      agentId,
      ...(version === undefined ? {} : { version }),
      status,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      steps,
      ...(failure === undefined ? {} : { failure })
    };
  };

  const availability = await environment.detect();
  const version = availability.version;
  if (!availability.installed)
    return finish("not-installed", {
      category: "agent",
      code: "AGENT_NOT_INSTALLED",
      message: availability.issue ?? "Executável do agente não encontrado."
    });
  if (!availability.authenticated)
    return finish("not-authenticated", {
      category: "authentication",
      code: "AGENT_NOT_AUTHENTICATED",
      message: availability.issue ?? "O agente não está autenticado."
    });

  let turn: PortalAgentTurn;
  try {
    turn = await environment.runTurn(buildPortalAgentPrompt({ ...options, expectedName }));
  } catch (error) {
    const cleanup = await environment.cleanup().catch(() => null);
    steps = { ...steps, cleanup: cleanup !== null && cleanupOk(cleanup) };
    return finish("failed", {
      category: "agent",
      code: "AGENT_PROCESS_FAILED",
      message: error instanceof Error ? error.message : "O processo do agente falhou."
    });
  }

  const observation = await environment.observe();
  const report = extractPortalAgentReport(turn.stdout);
  // Effects come first: the agent's own JSON only refines what the page and the runtime already show.
  steps = {
    listPortal: observation.listedByAgent || report?.portalId === options.portalId,
    navigate: observation.navigatedUrl.startsWith(options.fixtureUrl),
    click: observation.counter >= 1,
    type: observation.nameValue === expectedName,
    submit: observation.visibleResult.includes(expectedName),
    readResult:
      observation.visibleResult.includes(expectedName) &&
      (report?.visibleResult === undefined || report.visibleResult.includes(expectedName)),
    screenshot: observation.screenshotCount >= 1,
    console: observation.consoleEntries >= 1 || report?.consoleRead === true,
    revokedAfterDisconnect: false,
    cleanup: false
  };

  const flowComplete =
    steps.listPortal &&
    steps.navigate &&
    steps.click &&
    steps.type &&
    steps.submit &&
    steps.readResult &&
    steps.screenshot &&
    steps.console;

  if (!flowComplete) {
    const classified = classifyPortalAgentFailure(turn);
    const cleanup = await environment.cleanup().catch(() => null);
    steps = { ...steps, cleanup: cleanup !== null && cleanupOk(cleanup) };
    if (classified?.category === "provider")
      return finish("blocked-external", {
        category: "provider",
        code: classified.code ?? "EXTERNAL_PROVIDER_UNAVAILABLE",
        message: "O provedor externo do agente não respondeu; o Compazio não foi exercitado."
      });
    if (classified?.category === "authentication")
      return finish("not-authenticated", {
        category: "authentication",
        code: classified.code ?? "AGENT_NOT_AUTHENTICATED",
        message: "O agente não está autenticado."
      });
    return finish("failed", {
      category: classified?.category ?? "agent",
      ...(classified?.code === undefined ? {} : { code: classified.code }),
      message: `O fluxo de Portal não foi concluído: ${JSON.stringify(steps)}`
    });
  }

  const revocation = await environment.revoke();
  steps = {
    ...steps,
    revokedAfterDisconnect:
      revocation.attempted &&
      revocation.code === "PORTAL_NOT_CONNECTED" &&
      revocation.fixtureUnchanged
  };

  const cleanup = await environment.cleanup();
  steps = { ...steps, cleanup: cleanupOk(cleanup) };

  if (!steps.revokedAfterDisconnect)
    return finish("failed", {
      category: "portal",
      code: revocation.code,
      message: "Remover a conexão não revogou o controle do Portal."
    });
  if (!steps.cleanup)
    return finish("failed", {
      category: "cleanup",
      code: "RESOURCES_LEAKED",
      message: `Recursos permaneceram após o teste: ${JSON.stringify(cleanup)}`
    });
  return finish("passed");
}

/** Exit codes let a caller tell a Compazio defect from an external block without parsing output. */
export function portalAgentExitCode(probes: readonly RealPortalAgentProbe[]): number {
  if (probes.length === 0) return 4;
  if (probes.some((probe) => probe.status === "failed")) return 1;
  if (probes.some((probe) => probe.status === "blocked-external")) return 2;
  if (
    probes.every(
      (probe) => probe.status === "not-installed" || probe.status === "not-authenticated"
    )
  )
    return 3;
  return 0;
}

/** The saved report never carries the prompt, the output or anything the agent printed. */
export function sanitizePortalAgentProbe(probe: RealPortalAgentProbe): RealPortalAgentProbe {
  if (probe.failure === undefined) return probe;
  return {
    ...probe,
    failure: {
      category: probe.failure.category,
      ...(probe.failure.code === undefined ? {} : { code: probe.failure.code }),
      message: probe.failure.message.replace(/\s+/g, " ").slice(0, 240)
    }
  };
}
