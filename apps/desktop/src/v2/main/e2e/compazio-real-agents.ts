import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";
import {
  AgentRuntime,
  RoleInjectionService,
  V2ProcessSupervisor
} from "@forgedeck/compazio-v2-runtime";
import {
  PipeProcessFactory,
  PlatformProcessTreeKiller,
  PtyProcessFactory,
  TransportProcessFactory
} from "@forgedeck/terminal";

import {
  CompazioMcpGateway,
  type CompazioMcpBootstrap,
  type CompazioMcpHttpRequest,
  type CompazioMcpToolCall
} from "../compazio-mcp-gateway";
import { createPortalMcpLaunch, safePortalMcpDebugEvents } from "../portal-mcp-agent-config";
import { cleanupCompazioTemporaryDirectory } from "../compazio-temp-cleanup";
import type { PortalRuntimeManager } from "../portal-runtime-manager";
import { TeamCoordinator } from "../team-coordinator";
import { V2OperationalService } from "../operational-service";
import { isolatedTestEntitlement } from "../testing/isolated-entitlement";
import { V2WorkspaceService } from "../workspace-service";

const enabled = process.env.COMPAZIO_V2_COMPAZIO_REAL_AGENTS === "true";
const timeoutMs = Number(process.env.COMPAZIO_V2_COMPAZIO_REAL_TIMEOUT_MS ?? 180_000);
const debugEnabled = process.env.COMPAZIO_V2_COMPAZIO_AGENT_DEBUG === "1";
const harnessProfile = resolveHarnessProfile(process.argv.slice(2));
const claudeCompazioTools = [
  "team_recruit",
  "team_status",
  "team_list",
  "team_dismiss",
  "task_status",
  "task_result",
  "message_list"
] as const;

if (!enabled) {
  process.stdout.write(
    "Skipped: set COMPAZIO_V2_COMPAZIO_REAL_AGENTS=true to run real Claude/Codex Compazio MCP validation.\n"
  );
  process.exit(0);
}

async function main(): Promise<void> {
  debug("create-temporary-root");
  const root = await mkdtemp(join(tmpdir(), "compazio-agents-real-"));
  const repository = new V2WorkspaceRepository({ rootDirectory: join(root, "state") });
  const supervisor = new V2ProcessSupervisor(
    // Codex's Windows installation is a command shim. The production desktop runtime runs
    // interactive agents through a PTY, which safely resolves that shim without shell fallback.
    new TransportProcessFactory({ pty: new PtyProcessFactory(), pipe: new PipeProcessFactory() }),
    { treeKiller: new PlatformProcessTreeKiller(), gracePeriodMs: 100 }
  );
  const agents = new AgentRuntime({
    store: repository,
    roleInjection: new RoleInjectionService(join(root, "roles")),
    environment: process.env
  });
  const workspaces = new V2WorkspaceService({
    repository,
    supervisor,
    agents,
    entitlement: isolatedTestEntitlement(join(root, "state"))
  });
  const operations = new V2OperationalService({ repository, workspaces });
  const teams = new TeamCoordinator({ workspaces, operations, agents });
  const gateway = new CompazioMcpGateway(workspaces, {} as PortalRuntimeManager, teams);
  const calls: CompazioMcpToolCall[] = [];
  const requests: CompazioMcpHttpRequest[] = [];
  const unsubscribeCalls = gateway.subscribeToolCalls((call) => calls.push(call));
  const unsubscribeRequests = gateway.subscribeHttpRequests((request) => requests.push(request));
  let cleanupFailure: Error | undefined;
  try {
    profile: {
      debug("detect-agents");
      const [claude, codex] = await Promise.all([
        agents.detectOne("claude-code"),
        agents.detectOne("codex")
      ]);
      debug("agents-detected", { claude: claude.status, codex: codex.status });
      if (claude.status !== "installed" || codex.status !== "installed") {
        throw new Error(
          "Claude Code e Codex precisam estar instalados e autenticados para este teste."
        );
      }
      const [claudeCommand, codexCommand] = await Promise.all([
        resolveRealCommand("claude-code", claude.executablePath),
        resolveRealCommand("codex", codex.executablePath)
      ]);
      debug("commands-resolved", {
        claude: basename(claudeCommand.executable),
        codex: basename(codexCommand.executable)
      });
      await gateway.start();
      debug("gateway-started");
      if (harnessProfile.team === "mixed-dependent") {
        if (harnessProfile.compazioAgentId !== "claude-code")
          throw new Error("O cenário mixed-dependent desta onda exige Claude Code como Compazio.");
        await runClaudeCompazioMixedDependent({
          root,
          workspaces,
          operations,
          gateway,
          calls,
          requests,
          claudeCommand,
          codexCommand
        });
        break profile;
      }
      if (harnessProfile.compazioAgentId === "codex") {
        if (harnessProfile.recruitedAgentId !== "claude-code")
          throw new Error("O perfil Codex Compazio desta fatia recruta somente Claude Code.");
        await runCodexCompazioRecruitingClaude({
          root,
          workspaces,
          operations,
          gateway,
          calls,
          requests,
          codexCommand,
          claudeCommand
        });
        break profile;
      }
      if (harnessProfile.recruitedAgentId !== "codex")
        throw new Error("O perfil Claude Compazio da Onda 5A recruta somente Codex.");
      const workspace = await workspaces.create({ name: "Compazio real", workingDirectory: root });
      debug("workspace-created", { workspaceId: workspace.id });
      const withCompazio = await workspaces.addTerminal(workspace.id, {
        title: "Claude Compazio real",
        isCompazio: true,
        agentConfig: { agentId: "claude-code" },
        // The trusted terminal lifecycle is active during the probe. Real provider clients below
        // receive only short-lived MCP configuration and never a shell or a workspace token.
        launchConfig: {
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          env: {},
          processMode: "pipe"
        }
      });
      const compazio = withCompazio.nodes.find(
        (node) => node.type === "terminal" && node.isCompazio
      );
      if (compazio?.type !== "terminal") throw new Error("Compazio terminal missing");
      await workspaces.startTerminal(workspace.id, compazio.id);
      debug("compazio-terminal-started", {
        terminalId: compazio.id,
        isCompazio: compazio.isCompazio
      });

      const recruitSession = gateway.createAgentSession({
        workspaceId: workspace.id,
        terminalId: compazio.id,
        capabilities: [
          "team-read",
          "team-recruit",
          "team-manage",
          "task-create",
          "task-assign",
          "message-send"
        ]
      });
      debug("compazio-session-created", {
        sessionId: recruitSession.sessionId,
        tools: recruitSession.tools
      });
      const claudeVersion = await runVersion(claudeCommand.executable, claudeCommand.prefixArgs);
      debug("claude-version", { claudeVersion });
      debug("claude-recruit-turn-start");
      const recruitTurn = await runRealMcpTurn({
        agentId: "claude-code",
        command: claudeCommand,
        bootstrap: recruitSession,
        directory: join(root, "claude-recruit"),
        prompt: [
          "Use exclusivamente as ferramentas MCP do Compazio. Não use Bash, shell, terminal, filesystem, Git ou ferramentas externas.",
          "Chame team_recruit uma única vez com agentType codex, displayName Codex Test Engineer,",
          'role {name:"Test Engineer", description:"Valida o contrato", responsibilities:["Devolver resultado estruturado."]},',
          'initialTask {title:"Validar contrato", description:"Retorne um resultado estruturado dizendo que o contrato foi validado.", contextRefs:["compazio-real"]},',
          'e positionHint {direction:"right"}. Depois termine.'
        ].join(" "),
        allowedTools: claudeCompazioTools
      });
      debug("claude-recruit-turn-finished", {
        exitCode: recruitTurn.exitCode,
        timedOut: recruitTurn.timedOut
      });
      const recruitRequests = requests.filter(
        (request) => request.compazioSessionId === recruitSession.sessionId
      );
      const recruitCalls = calls.filter(
        (call) => call.compazioSessionId === recruitSession.sessionId
      );
      emitClaudeProbeDiagnostic({
        command: recruitTurn.command,
        claudeVersion,
        temporaryMcpConfiguration: recruitTurn.configuration,
        workspaceId: workspace.id,
        terminalId: compazio.id,
        compazioSessionId: recruitSession.sessionId,
        capabilities: [
          "team-read",
          "team-recruit",
          "team-manage",
          "task-create",
          "task-assign",
          "message-send"
        ],
        isCompazio: compazio.isCompazio,
        requests: recruitRequests,
        calls: recruitCalls,
        turn: recruitTurn
      });
      await gateway.revokeAgentSession(recruitSession.sessionId);
      if (!calls.some((call) => call.tool === "team_recruit" && call.ok))
        throw new Error(
          `The real Claude client did not complete an accepted team_recruit MCP call (${classifyClaudeRecruitFailure(
            recruitTurn,
            recruitRequests,
            recruitCalls
          )}).`
        );

      const recruited = await waitFor("recrutamento persistido", async () => {
        const state = await operations.get(workspace.id);
        const member = state.teamMembers.find(
          (candidate) => candidate.recruitedByTerminalId === compazio.id
        );
        const task =
          member === undefined
            ? undefined
            : state.teamTasks.find(
                (candidate) => candidate.assignedToTerminalId === member.terminalId
              );
        return member === undefined || task === undefined ? undefined : { member, task };
      });
      if (
        recruited.member.agentType !== "codex" ||
        recruited.member.role.name !== "Test Engineer"
      ) {
        throw new Error("The real Claude turn did not create the expected Codex Test Engineer.");
      }

      const resultSession = gateway.createAgentSession({
        workspaceId: workspace.id,
        terminalId: recruited.member.terminalId,
        capabilities: ["team-read", "message-send", "result-return"]
      });
      await runRealMcpTurn({
        agentId: "codex",
        command: codexCommand,
        bootstrap: resultSession,
        directory: join(root, "codex-result"),
        prompt: [
          "Use exclusivamente as ferramentas MCP task_status e task_result do Compazio; não use shell, filesystem, Git ou ferramentas externas.",
          `Chame task_status para a tarefa ${recruited.task.id}.`,
          `Depois chame task_result para ${recruited.task.id} com result.summary exatamente "Contrato validado por Codex real" e artifacts ["compazio-real-report"].`,
          "Depois termine."
        ].join(" "),
        allowedTools: ["task_status", "task_result"]
      });
      await gateway.revokeAgentSession(resultSession.sessionId);
      if (!calls.some((call) => call.tool === "task_result" && call.ok))
        throw new Error(
          "The real Codex client completed without an accepted task_result MCP call."
        );

      const completed = await waitFor("resultado estruturado", async () => {
        const task = (await operations.get(workspace.id)).teamTasks.find(
          (candidate) => candidate.id === recruited.task.id
        );
        return task?.status === "completed" ? task : undefined;
      });
      if (completed.result?.summary !== "Contrato validado por Codex real") {
        throw new Error("The real Codex turn did not persist the required structured result.");
      }
      const completionMessage = (await operations.get(workspace.id)).messages.find(
        (message) =>
          message.fromTerminalId === recruited.member.terminalId &&
          message.toTerminalId === compazio.id &&
          message.type === "result"
      );
      if (completionMessage === undefined)
        throw new Error("The real Codex result was not delivered back to the Compazio.");

      const reviewSession = gateway.createAgentSession({
        workspaceId: workspace.id,
        terminalId: compazio.id,
        capabilities: ["team-read", "message-send"]
      });
      await runRealMcpTurn({
        agentId: "claude-code",
        command: claudeCommand,
        bootstrap: reviewSession,
        directory: join(root, "claude-review"),
        prompt: [
          "Use exclusivamente as ferramentas MCP do Compazio.",
          "Chame team_status.",
          `Depois chame task_status e task_result para a tarefa ${recruited.task.id}.`,
          "Depois chame message_list. Não use Bash, shell, terminal, filesystem, Git ou ferramentas externas. Depois termine."
        ].join(" "),
        allowedTools: ["team_status", "task_status", "task_result", "message_list"]
      });
      const reviewCalls = calls.filter(
        (call) => call.compazioSessionId === reviewSession.sessionId && call.ok
      );
      await gateway.revokeAgentSession(reviewSession.sessionId);
      for (const tool of ["team_status", "task_status", "task_result", "message_list"] as const) {
        if (!reviewCalls.some((call) => call.tool === tool))
          throw new Error(`The real Claude review turn did not complete ${tool}.`);
      }

      const dismissSession = gateway.createAgentSession({
        workspaceId: workspace.id,
        terminalId: compazio.id,
        capabilities: ["team-manage"]
      });
      await runRealMcpTurn({
        agentId: "claude-code",
        command: claudeCommand,
        bootstrap: dismissSession,
        directory: join(root, "claude-dismiss"),
        prompt: [
          "Use exclusivamente a ferramenta MCP team_dismiss do Compazio.",
          `Dispense o integrante ${recruited.member.id} com a razão "Resultado recebido".`,
          "Não use shell, terminal, filesystem, Git ou ferramentas externas. Depois termine."
        ].join(" "),
        allowedTools: ["team_dismiss"]
      });
      await gateway.revokeAgentSession(dismissSession.sessionId);
      if (!calls.some((call) => call.tool === "team_dismiss" && call.ok))
        throw new Error(
          "The real Claude client completed without an accepted team_dismiss MCP call."
        );

      const dismissed = await waitFor("dispensa persistida", async () => {
        const member = (await operations.get(workspace.id)).teamMembers.find(
          (candidate) => candidate.id === recruited.member.id
        );
        return member?.status === "dismissed" ? member : undefined;
      });
      const restored = await workspaces.snapshot(workspace.id);
      if (
        workspaces.sessionForNode(workspace.id, dismissed.terminalId) !== null ||
        restored.edges.some(
          (edge) =>
            edge.sourceNodeId === dismissed.terminalId || edge.targetNodeId === dismissed.terminalId
        )
      ) {
        throw new Error("Dismissal did not clean the recruited process and team connections.");
      }
      process.stdout.write(
        "COMPAZIO REAL CHECK: Claude recruited Codex, Codex returned a structured result, Claude dismissed it.\n"
      );
    }
  } finally {
    debug("cleanup-start");
    unsubscribeCalls();
    unsubscribeRequests();
    const shutdown = await Promise.allSettled([gateway.shutdown(), workspaces.shutdown()]);
    const temporaryCleanup = await cleanupCompazioTemporaryDirectory(root).then(
      () => undefined,
      (error: unknown) => error
    );
    const gatewayDiagnostics = gateway.diagnostics();
    const remainingSupervisorSessions = supervisor.list();
    const shutdownFailures = shutdown.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (
      temporaryCleanup !== undefined ||
      shutdownFailures.length > 0 ||
      gatewayDiagnostics.listening ||
      gatewayDiagnostics.activeSessionCount !== 0 ||
      gatewayDiagnostics.transportCount !== 0 ||
      remainingSupervisorSessions.length !== 0
    ) {
      cleanupFailure = new Error(
        `Compazio harness cleanup is incomplete: ${JSON.stringify({
          temporaryCleanup:
            temporaryCleanup instanceof Error ? temporaryCleanup.message : undefined,
          shutdownFailures: shutdownFailures.length,
          gateway: gatewayDiagnostics,
          supervisorSessions: remainingSupervisorSessions.length
        })}`
      );
      debug("cleanup-failed", { message: cleanupFailure.message });
    }
    debug("cleanup-finished");
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

type CompazioHarnessAgent = "claude-code" | "codex";

interface CompazioHarnessProfile {
  readonly compazioAgentId: CompazioHarnessAgent;
  readonly recruitedAgentId: CompazioHarnessAgent;
  readonly team?: "mixed-dependent";
}

function resolveHarnessProfile(args: readonly string[]): CompazioHarnessProfile {
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const compazio = valueAfter("--compazio") ?? "claude-code";
  const recruit = valueAfter("--recruit") ?? "codex";
  const team = valueAfter("--team");
  if (
    (compazio !== "claude" && compazio !== "claude-code" && compazio !== "codex") ||
    (recruit !== "claude" && recruit !== "claude-code" && recruit !== "codex")
  ) {
    throw new Error("Use --compazio <claude-code|codex> --recruit <claude-code|codex>.");
  }
  const compazioAgentId: CompazioHarnessAgent = compazio === "claude" ? "claude-code" : compazio;
  const recruitedAgentId: CompazioHarnessAgent = recruit === "claude" ? "claude-code" : recruit;
  if (team !== undefined && team !== "mixed-dependent")
    throw new Error("Use --team mixed-dependent ou omita --team.");
  if (team === "mixed-dependent" && compazioAgentId !== "claude-code")
    throw new Error("--team mixed-dependent exige --compazio claude-code.");
  if (compazioAgentId === recruitedAgentId)
    throw new Error("O Compazio e o integrante recrutado precisam usar adapters diferentes.");
  return { compazioAgentId, recruitedAgentId, ...(team === undefined ? {} : { team }) };
}

/**
 * The Wave 5C proof deliberately uses short, independent provider turns. The durable TeamRun,
 * scheduler and message bus are the source of truth; a model's final prose is never accepted as
 * evidence of a task result, review, dependency release or dismissal.
 */
async function runClaudeCompazioMixedDependent(input: {
  readonly root: string;
  readonly workspaces: V2WorkspaceService;
  readonly operations: V2OperationalService;
  readonly gateway: CompazioMcpGateway;
  readonly calls: CompazioMcpToolCall[];
  readonly requests: CompazioMcpHttpRequest[];
  readonly claudeCommand: { readonly executable: string; readonly prefixArgs: readonly string[] };
  readonly codexCommand: { readonly executable: string; readonly prefixArgs: readonly string[] };
}): Promise<void> {
  const workspace = await input.workspaces.create({
    name: "Claude mixed dependent team",
    workingDirectory: input.root
  });
  const created = await input.workspaces.addTerminal(workspace.id, {
    title: "Claude Compazio mixed real",
    isCompazio: true,
    agentConfig: { agentId: "claude-code" },
    launchConfig: {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: {},
      processMode: "pipe"
    }
  });
  const compazio = created.nodes.find((node) => node.type === "terminal" && node.isCompazio);
  if (compazio?.type !== "terminal") throw new Error("Mixed Compazio terminal missing");
  await input.workspaces.startTerminal(workspace.id, compazio.id);

  const compazioCapabilities = [
    "team-read",
    "team-recruit",
    "team-manage",
    "team-run-manage",
    "task-create",
    "task-assign",
    "task-cancel",
    "message-send",
    "connection-manage"
  ] as const;
  const createSession = input.gateway.createAgentSession({
    workspaceId: workspace.id,
    terminalId: compazio.id,
    capabilities: compazioCapabilities
  });
  const createTurn = await runRealMcpTurn({
    agentId: "claude-code",
    command: input.claudeCommand,
    bootstrap: createSession,
    directory: join(input.root, "claude-mixed-create"),
    prompt: [
      "Use exclusivamente a ferramenta MCP team_run_create do Compazio. Não use Bash, shell, terminal, filesystem, Git, navegador ou ferramentas externas.",
      "Crie uma execução com title API Tasks e objective Produzir e revisar uma proposta de contrato de API para um serviço de tarefas.",
      "Os membros são Codex Implementation Engineer (agentType codex, role Implementation Engineer, responsabilidade Definir o contrato de API) e Claude Architecture Reviewer (agentType claude-code, role Architecture Reviewer, responsabilidade Revisar a proposta de API).",
      "As tarefas são implementation: title Definir POST /tasks, description Retorne a proposta estruturada do contrato, assignedMemberName Codex Implementation Engineer;",
      "e review: title Revisar contrato de tarefas, description Revise a proposta e devolva uma opinião estruturada, assignedMemberName Claude Architecture Reviewer, dependsOn [implementation], reviewOf implementation. Depois termine."
    ].join(" "),
    allowedTools: ["team_run_create"]
  });
  const createCalls = input.calls.filter(
    (call) => call.compazioSessionId === createSession.sessionId
  );
  const createRequests = input.requests.filter(
    (request) => request.compazioSessionId === createSession.sessionId
  );
  await input.gateway.revokeAgentSession(createSession.sessionId);
  if (!createRequests.some((request) => request.rpcMethod === "tools/list"))
    throw new Error("The real Claude Compazio did not discover the mixed team MCP tool.");
  if (!createCalls.some((call) => call.tool === "team_run_create" && call.ok))
    throw new Error(
      `The real Claude Compazio did not create the mixed TeamRun (${classifyClaudeRecruitFailure(
        createTurn,
        createRequests,
        createCalls
      )}).`
    );

  const team = await waitFor("TeamRun misto persistido", async () => {
    const state = await input.operations.get(workspace.id);
    const run = state.teamRuns.find((candidate) => candidate.compazioTerminalId === compazio.id);
    if (run === undefined || run.memberIds.length !== 2 || run.taskIds.length !== 2)
      return undefined;
    const members = state.teamMembers.filter((member) => run.memberIds.includes(member.id));
    const implementation = state.teamTasks.find((task) => task.id === run.taskIds[0]);
    const review = state.teamTasks.find((task) => task.id === run.taskIds[1]);
    if (members.length !== 2 || implementation === undefined || review === undefined)
      return undefined;
    return { run, members, implementation, review };
  });
  const implementation = team.members.find((member) => member.agentType === "codex");
  const reviewer = team.members.find((member) => member.agentType === "claude-code");
  if (implementation === undefined || reviewer === undefined)
    throw new Error("The TeamRun did not create the required mixed providers.");
  const implementationTask = [team.implementation, team.review].find(
    (task) => task.assignedToTerminalId === implementation.terminalId
  );
  const reviewTask = [team.implementation, team.review].find(
    (task) => task.assignedToTerminalId === reviewer.terminalId
  );
  if (
    implementationTask === undefined ||
    reviewTask === undefined ||
    reviewTask.status !== "blocked"
  )
    throw new Error("The mixed TeamRun did not preserve the blocked review dependency.");

  const implementationSession = input.gateway.createAgentSession({
    workspaceId: workspace.id,
    terminalId: implementation.terminalId,
    capabilities: ["team-read", "message-send", "result-return"]
  });
  const implementationTurn = await runRealMcpTurn({
    agentId: "codex",
    command: input.codexCommand,
    bootstrap: implementationSession,
    directory: join(input.root, "codex-implementation"),
    prompt: [
      "Use exclusivamente as ferramentas MCP task_status e task_result do Compazio. Não use shell, filesystem, Git, navegador ou ferramentas externas.",
      `Chame task_status para a tarefa ${implementationTask.id}.`,
      `Depois chame task_result para ${implementationTask.id} com result.summary exatamente {"endpoint":"/tasks","method":"POST","requestFields":["title"],"responseStatus":201,"testsSuggested":["missing title","valid title"]} e artifacts ["implementation-report"]. Depois termine.`
    ].join(" "),
    allowedTools: ["task_status", "task_result"]
  });
  const implementationCalls = input.calls.filter(
    (call) => call.compazioSessionId === implementationSession.sessionId
  );
  await input.gateway.revokeAgentSession(implementationSession.sessionId);
  for (const tool of ["task_status", "task_result"] as const) {
    if (!implementationCalls.some((call) => call.tool === tool && call.ok))
      throw new Error(
        `The real Codex implementation turn did not complete ${tool}: ${JSON.stringify({
          calls: implementationCalls,
          transcript: safeAgentTranscript(implementationTurn.output).slice(-4_000)
        })}`
      );
  }
  if (implementationTurn.timedOut)
    throw new Error(
      "The real Codex implementation turn timed out before returning its task result."
    );

  const released = await waitFor("revisão liberada", async () => {
    const state = await input.operations.get(workspace.id);
    const task = state.teamTasks.find((candidate) => candidate.id === reviewTask.id);
    const context = state.messages.find(
      (message) =>
        message.fromTerminalId === implementation.terminalId &&
        message.toTerminalId === reviewer.terminalId &&
        message.type === "result"
    );
    return task?.status === "running" && context !== undefined ? { task, context } : undefined;
  });
  if (!released.task.resultRefs.includes(implementationTask.id))
    throw new Error("The scheduler did not retain the implementation result reference for review.");

  const reviewSession = input.gateway.createAgentSession({
    workspaceId: workspace.id,
    terminalId: reviewer.terminalId,
    capabilities: ["team-read", "message-send", "result-return"]
  });
  const reviewTurn = await runRealMcpTurn({
    agentId: "claude-code",
    command: input.claudeCommand,
    bootstrap: reviewSession,
    directory: join(input.root, "claude-review"),
    prompt: [
      "Use exclusivamente as ferramentas MCP message_list, message_acknowledge, task_status e task_result do Compazio. Não use Bash, shell, terminal, filesystem, Git, navegador ou ferramentas externas.",
      "Chame message_list, encontre a mensagem de resultado recebida e confirme-a com message_acknowledge.",
      `Depois chame task_status para a tarefa ${released.task.id}.`,
      `Depois chame task_result para ${released.task.id} com result.summary exatamente {"approved":true,"risks":["versioning"],"recommendations":["document errors"],"reviewedEndpoint":"/tasks"} e artifacts ["review-report"]. Depois termine.`
    ].join(" "),
    allowedTools: ["message_list", "message_acknowledge", "task_status", "task_result"]
  });
  const reviewCalls = input.calls.filter(
    (call) => call.compazioSessionId === reviewSession.sessionId
  );
  await input.gateway.revokeAgentSession(reviewSession.sessionId);
  for (const tool of [
    "message_list",
    "message_acknowledge",
    "task_status",
    "task_result"
  ] as const) {
    if (!reviewCalls.some((call) => call.tool === tool && call.ok))
      throw new Error(
        `The real Claude review turn did not complete ${tool}: ${JSON.stringify({
          calls: reviewCalls,
          transcript: safeAgentTranscript(reviewTurn.output).slice(-4_000)
        })}`
      );
  }
  if (reviewTurn.timedOut)
    throw new Error("The real Claude review turn timed out before returning its review.");

  const completed = await waitFor("TeamRun concluído", async () => {
    const state = await input.operations.get(workspace.id);
    const run = state.teamRuns.find((candidate) => candidate.id === team.run.id);
    const review = state.teamTasks.find((candidate) => candidate.id === reviewTask.id);
    const message = state.messages.find((candidate) => candidate.id === released.context.id);
    return run?.status === "completed" &&
      review?.status === "completed" &&
      message?.status === "acknowledged"
      ? { run, review }
      : undefined;
  });
  if (!completed.review.result?.summary.includes('"approved":true'))
    throw new Error("The real Claude reviewer did not return the required structured review.");

  const closeSession = input.gateway.createAgentSession({
    workspaceId: workspace.id,
    terminalId: compazio.id,
    capabilities: ["team-read", "team-manage", "team-run-manage"]
  });
  const closeTurn = await runRealMcpTurn({
    agentId: "claude-code",
    command: input.claudeCommand,
    bootstrap: closeSession,
    directory: join(input.root, "claude-mixed-close"),
    prompt: [
      "Use exclusivamente as ferramentas MCP team_run_status, team_list e team_dismiss do Compazio. Não use Bash, shell, terminal, filesystem, Git, navegador ou ferramentas externas.",
      `Chame team_run_status para ${team.run.id}, depois team_list.`,
      `Dispense o integrante ${implementation.id} com razão execução concluída.`,
      `Dispense o integrante ${reviewer.id} com razão execução concluída. Depois termine.`
    ].join(" "),
    allowedTools: ["team_run_status", "team_list", "team_dismiss"]
  });
  const closeCalls = input.calls.filter(
    (call) => call.compazioSessionId === closeSession.sessionId
  );
  await input.gateway.revokeAgentSession(closeSession.sessionId);
  for (const tool of ["team_run_status", "team_list", "team_dismiss"] as const) {
    if (!closeCalls.some((call) => call.tool === tool && call.ok))
      throw new Error(
        `The real Claude close turn did not complete ${tool}: ${JSON.stringify({
          calls: closeCalls,
          transcript: safeAgentTranscript(closeTurn.output).slice(-4_000)
        })}`
      );
  }
  if (closeTurn.timedOut) throw new Error("The real Claude close turn timed out before dismissal.");
  const dismissed = await waitFor("dispensa da equipe mista", async () => {
    const state = await input.operations.get(workspace.id);
    return team.members.every(
      (member) =>
        state.teamMembers.find((candidate) => candidate.id === member.id)?.status === "dismissed"
    )
      ? state
      : undefined;
  });
  const restored = await input.workspaces.snapshot(workspace.id);
  if (
    team.members.some(
      (member) => input.workspaces.sessionForNode(workspace.id, member.terminalId) !== null
    ) ||
    restored.edges.some((edge) =>
      team.members.some(
        (member) =>
          edge.sourceNodeId === member.terminalId || edge.targetNodeId === member.terminalId
      )
    ) ||
    dismissed.messages.some((message) => message.status === "delivering")
  ) {
    throw new Error("Mixed TeamRun dismissal did not clean worker resources.");
  }
  process.stdout.write(
    "COMPAZIO REAL CHECK: Claude created a mixed dependent team, Codex implemented, Claude reviewed, and Claude dismissed both workers.\n"
  );
}

async function runCodexCompazioRecruitingClaude(input: {
  readonly root: string;
  readonly workspaces: V2WorkspaceService;
  readonly operations: V2OperationalService;
  readonly gateway: CompazioMcpGateway;
  readonly calls: CompazioMcpToolCall[];
  readonly requests: CompazioMcpHttpRequest[];
  readonly codexCommand: { readonly executable: string; readonly prefixArgs: readonly string[] };
  readonly claudeCommand: { readonly executable: string; readonly prefixArgs: readonly string[] };
}): Promise<void> {
  const workspace = await input.workspaces.create({
    name: "Codex Compazio real",
    workingDirectory: input.root
  });
  const withCompazio = await input.workspaces.addTerminal(workspace.id, {
    title: "Codex Compazio real",
    isCompazio: true,
    agentConfig: { agentId: "codex" },
    // The persistent terminal is supervised independently of the external provider turn below.
    // The latter exists only to make observable, MCP-only calls with a deterministic transcript.
    launchConfig: {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: {},
      processMode: "pipe"
    }
  });
  const compazio = withCompazio.nodes.find((node) => node.type === "terminal" && node.isCompazio);
  if (compazio?.type !== "terminal") throw new Error("Codex Compazio terminal missing");
  await input.workspaces.startTerminal(workspace.id, compazio.id);
  debug("codex-compazio-terminal-started", {
    terminalId: compazio.id,
    isCompazio: compazio.isCompazio
  });

  const compazioCapabilities = [
    "team-read",
    "team-recruit",
    "team-manage",
    "task-create",
    "task-assign",
    "message-send"
  ] as const;
  const recruitSession = input.gateway.createAgentSession({
    workspaceId: workspace.id,
    terminalId: compazio.id,
    capabilities: compazioCapabilities
  });
  const recruitTurn = await runRealMcpTurn({
    agentId: "codex",
    command: input.codexCommand,
    bootstrap: recruitSession,
    directory: join(input.root, "codex-recruit"),
    prompt: [
      "Use exclusivamente as ferramentas MCP do Compazio. Não use shell, terminal, filesystem, Git, navegador ou ferramentas externas.",
      "Chame team_recruit uma única vez com agentType claude-code, displayName Claude Architecture Reviewer,",
      'role {name:"Architecture Reviewer", description:"Revisa arquitetura e limites", responsibilities:["analisar o material fornecido","identificar riscos arquiteturais","retornar recomendação estruturada","informar bloqueios ao Compazio"]},',
      'initialTask {title:"Revisar arquitetura da fixture", description:"Analise gateway MCP, autorização por capability, persistência, lifecycle e cleanup; devolva uma revisão estruturada.", contextRefs:["compazio-codex-real"]},',
      'e positionHint {direction:"right"}. Depois termine.'
    ].join(" "),
    allowedTools: claudeCompazioTools
  });
  debug("codex-recruit-turn-finished", {
    exitCode: recruitTurn.exitCode,
    timedOut: recruitTurn.timedOut,
    transcript: safeAgentTranscript(recruitTurn.output)
  });
  const recruitRequests = input.requests.filter(
    (request) => request.compazioSessionId === recruitSession.sessionId
  );
  const recruitCalls = input.calls.filter(
    (call) => call.compazioSessionId === recruitSession.sessionId
  );
  await input.gateway.revokeAgentSession(recruitSession.sessionId);
  if (!recruitRequests.some((request) => request.rpcMethod === "tools/list"))
    throw new Error("The real Codex client did not discover the Compazio MCP tools.");
  if (!recruitCalls.some((call) => call.tool === "team_recruit" && call.ok))
    throw new Error(
      `The real Codex client did not complete an accepted team_recruit MCP call (${classifyCodexRecruitFailure(
        recruitTurn,
        recruitCalls
      )}).`
    );

  const recruited = await waitFor("recrutamento Claude persistido", async () => {
    const state = await input.operations.get(workspace.id);
    const member = state.teamMembers.find(
      (candidate) => candidate.recruitedByTerminalId === compazio.id
    );
    const task =
      member === undefined
        ? undefined
        : state.teamTasks.find((candidate) => candidate.assignedToTerminalId === member.terminalId);
    return member === undefined || task === undefined ? undefined : { member, task };
  });
  if (
    recruited.member.agentType !== "claude-code" ||
    recruited.member.role.name !== "Architecture Reviewer"
  ) {
    throw new Error(
      "The real Codex turn did not create the expected Claude Architecture Reviewer."
    );
  }
  if (input.workspaces.sessionForNode(workspace.id, recruited.member.terminalId) === null)
    throw new Error("The recruited Claude process did not become active.");

  const resultSession = input.gateway.createAgentSession({
    workspaceId: workspace.id,
    terminalId: recruited.member.terminalId,
    capabilities: ["team-read", "message-send", "result-return"]
  });
  const resultTurn = await runRealMcpTurn({
    agentId: "claude-code",
    command: input.claudeCommand,
    bootstrap: resultSession,
    directory: join(input.root, "claude-result"),
    prompt: [
      "Use exclusivamente as ferramentas MCP task_status, task_result e message_send do Compazio; não use Bash, shell, terminal, filesystem, Git ou ferramentas externas.",
      `Chame task_status para a tarefa ${recruited.task.id}.`,
      `Depois chame task_result para ${recruited.task.id} com result.summary exatamente "Revisão aprovada por Claude real" e artifacts ["architecture-review"].`,
      "Depois termine."
    ].join(" "),
    allowedTools: ["task_status", "task_result", "message_send"]
  });
  const resultCalls = input.calls.filter(
    (call) => call.compazioSessionId === resultSession.sessionId
  );
  await input.gateway.revokeAgentSession(resultSession.sessionId);
  if (!resultCalls.some((call) => call.tool === "task_status" && call.ok))
    throw new Error("The recruited real Claude did not inspect its assigned task through MCP.");
  if (!resultCalls.some((call) => call.tool === "task_result" && call.ok))
    throw new Error(
      `The recruited real Claude did not complete task_result (${classifyClaudeRecruitFailure(
        resultTurn,
        input.requests.filter((request) => request.compazioSessionId === resultSession.sessionId),
        resultCalls
      )}).`
    );

  const completed = await waitFor("resultado Claude estruturado", async () => {
    const task = (await input.operations.get(workspace.id)).teamTasks.find(
      (candidate) => candidate.id === recruited.task.id
    );
    return task?.status === "completed" ? task : undefined;
  });
  if (completed.result?.summary !== "Revisão aprovada por Claude real")
    throw new Error("The real Claude turn did not persist the required structured review.");
  const resultMessage = (await input.operations.get(workspace.id)).messages.find(
    (message) =>
      message.fromTerminalId === recruited.member.terminalId &&
      message.toTerminalId === compazio.id &&
      message.type === "result"
  );
  if (resultMessage === undefined)
    throw new Error("The real Claude result was not delivered back to the Codex Compazio.");

  const reviewSession = input.gateway.createAgentSession({
    workspaceId: workspace.id,
    terminalId: compazio.id,
    capabilities: ["team-read", "message-send"]
  });
  await runRealMcpTurn({
    agentId: "codex",
    command: input.codexCommand,
    bootstrap: reviewSession,
    directory: join(input.root, "codex-review"),
    prompt: [
      "Use exclusivamente as ferramentas MCP do Compazio.",
      "Chame team_status.",
      `Depois chame task_status e task_result para a tarefa ${recruited.task.id}.`,
      "Depois chame message_list. Não use shell, terminal, filesystem, Git ou ferramentas externas. Depois termine."
    ].join(" "),
    allowedTools: ["team_status", "task_status", "task_result", "message_list"]
  });
  const reviewCalls = input.calls.filter(
    (call) => call.compazioSessionId === reviewSession.sessionId && call.ok
  );
  await input.gateway.revokeAgentSession(reviewSession.sessionId);
  for (const tool of ["team_status", "task_status", "task_result", "message_list"] as const) {
    if (!reviewCalls.some((call) => call.tool === tool))
      throw new Error(`The real Codex review turn did not complete ${tool}.`);
  }

  const dismissSession = input.gateway.createAgentSession({
    workspaceId: workspace.id,
    terminalId: compazio.id,
    capabilities: ["team-manage"]
  });
  await runRealMcpTurn({
    agentId: "codex",
    command: input.codexCommand,
    bootstrap: dismissSession,
    directory: join(input.root, "codex-dismiss"),
    prompt: [
      "Use exclusivamente a ferramenta MCP team_dismiss do Compazio.",
      `Dispense o integrante ${recruited.member.id} com a razão "Revisão recebida".`,
      "Não use shell, terminal, filesystem, Git ou ferramentas externas. Depois termine."
    ].join(" "),
    allowedTools: ["team_dismiss"]
  });
  const dismissCalls = input.calls.filter(
    (call) => call.compazioSessionId === dismissSession.sessionId
  );
  await input.gateway.revokeAgentSession(dismissSession.sessionId);
  if (!dismissCalls.some((call) => call.tool === "team_dismiss" && call.ok))
    throw new Error("The real Codex client completed without an accepted team_dismiss MCP call.");
  const dismissed = await waitFor("dispensa Claude persistida", async () => {
    const member = (await input.operations.get(workspace.id)).teamMembers.find(
      (candidate) => candidate.id === recruited.member.id
    );
    return member?.status === "dismissed" ? member : undefined;
  });
  const restored = await input.workspaces.snapshot(workspace.id);
  if (
    input.workspaces.sessionForNode(workspace.id, dismissed.terminalId) !== null ||
    restored.edges.some(
      (edge) =>
        edge.sourceNodeId === dismissed.terminalId || edge.targetNodeId === dismissed.terminalId
    )
  ) {
    throw new Error("Dismissal did not clean the recruited Claude process and team connections.");
  }
  process.stdout.write(
    "COMPAZIO REAL CHECK: Codex recruited Claude, Claude returned a structured result, Codex dismissed it.\n"
  );
}

async function runRealMcpTurn(input: {
  readonly agentId: "claude-code" | "codex";
  readonly command: { readonly executable: string; readonly prefixArgs: readonly string[] };
  readonly bootstrap: CompazioMcpBootstrap;
  readonly directory: string;
  readonly prompt: string;
  readonly allowedTools?: readonly string[];
}): Promise<{
  readonly output: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly command: readonly string[];
  readonly configuration: {
    readonly strictMcpConfig: boolean;
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
  };
}> {
  await mkdir(input.directory, { recursive: true });
  const launch = await createPortalMcpLaunch({
    agentId: input.agentId,
    directory: input.directory,
    endpoint: input.bootstrap.endpoint,
    token: input.bootstrap.token,
    tools: input.allowedTools ?? input.bootstrap.tools,
    prompt: input.prompt
  });
  try {
    const command = [...input.command.prefixArgs, ...launch.args];
    debug("agent-process-start", {
      agentId: input.agentId,
      executable: basename(input.command.executable),
      allowedTools: input.allowedTools ?? input.bootstrap.tools
    });
    const result = await runProcess(
      input.command.executable,
      command,
      launch.environment,
      input.agentId === "codex"
    );
    return {
      ...result,
      command: [basename(input.command.executable), ...safeCommandArguments(command)],
      configuration: {
        strictMcpConfig: launch.args.includes("--strict-mcp-config"),
        allowedTools: optionList(launch.args, "--allowedTools"),
        disallowedTools: optionList(launch.args, "--disallowedTools")
      }
    };
  } finally {
    await launch.cleanup();
  }
}

function runProcess(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  closeStandardInput = false
): Promise<{
  readonly output: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: process.cwd(),
      windowsHide: true,
      env: { ...process.env, ...environment },
      // Claude 2.1.220 completes remote-MCP discovery through its regular stdin pipe even when
      // the prompt is an argv argument. Codex exits deterministically only after stdin is closed.
      // This affects client process lifecycle only; neither model gets a shell or prompt stdin.
      stdio: [closeStandardInput ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    const maximumOutputBytes = 4 * 1024 * 1024;
    const append = (chunk: Buffer | string): void => {
      if (Buffer.byteLength(output) >= maximumOutputBytes) return;
      const remaining = maximumOutputBytes - Buffer.byteLength(output);
      output += Buffer.from(chunk).subarray(0, remaining).toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      debug("agent-process-timeout", { executable: basename(executable), pid: child.pid ?? null });
      if (child.pid === undefined) return;
      // `execFile` only terminates its direct child on Windows. Provider CLIs may retain helper
      // children, which in turn keeps their MCP HTTP connection and the temporary directory open.
      // The harness owns this PID, so a process-tree kill is safe and mirrors production cleanup.
      void new PlatformProcessTreeKiller().kill(child.pid).catch((error: unknown) => {
        if (!settled) reject(error);
      });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      debug("agent-process-closed", {
        executable: basename(executable),
        exitCode: timedOut ? null : code,
        timedOut
      });
      resolve({ output, exitCode: timedOut ? null : code, timedOut });
    });
  });
}

function debug(stage: string, details: Record<string, unknown> = {}): void {
  if (!debugEnabled) return;
  process.stdout.write(`COMPAZIO DEBUG: ${JSON.stringify({ stage, ...details })}\n`);
}

async function runVersion(executable: string, prefixArgs: readonly string[]): Promise<string> {
  const result = await runProcess(executable, [...prefixArgs, "--version"], {});
  return result.output.trim().split(/\s+/)[0] ?? "unknown";
}

function optionList(args: readonly string[], option: string): readonly string[] {
  const value = args[args.indexOf(option) + 1];
  return value === undefined ? [] : value.split(",").filter(Boolean);
}

function safeCommandArguments(args: readonly string[]): readonly string[] {
  return args.map((argument) =>
    /(?:compazio-mcp\.json|claude-mcp-settings\.json)/i.test(argument)
      ? "[TEMP_MCP_CONFIG]"
      : argument.length > 1_000
        ? "[PROMPT]"
        : argument
  );
}

function safeAgentTranscript(output: string): string {
  return output
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/COMPAZIO_MCP_TOKEN=[^\s]+/gi, "COMPAZIO_MCP_TOKEN=[REDACTED]")
    .replace(/[A-Za-z]:\\Users\\[^\s"']+/g, "[LOCAL_PATH]");
}

function emitClaudeProbeDiagnostic(input: {
  readonly command: readonly string[];
  readonly claudeVersion: string;
  readonly temporaryMcpConfiguration: {
    readonly strictMcpConfig: boolean;
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
  };
  readonly workspaceId: string;
  readonly terminalId: string;
  readonly compazioSessionId: string;
  readonly capabilities: readonly string[];
  readonly isCompazio: boolean;
  readonly requests: readonly CompazioMcpHttpRequest[];
  readonly calls: readonly CompazioMcpToolCall[];
  readonly turn: {
    readonly output: string;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
  };
}): void {
  const advertisedTools = input.requests
    .filter((request) => request.rpcMethod === "tools/list")
    .flatMap((request) => request.advertisedTools ?? []);
  const outputEvents = safePortalMcpDebugEvents(input.turn.output);
  process.stdout.write(
    `COMPAZIO CLAUDE PROBE: ${JSON.stringify({
      command: input.command,
      claudeVersion: input.claudeVersion,
      temporaryMcpConfiguration: input.temporaryMcpConfiguration,
      mcpInitialize: input.requests.some((request) => request.rpcMethod === "initialize"),
      protocolVersion: input.requests.find((request) => request.protocolVersion !== undefined)
        ?.protocolVersion,
      toolsListReceived: input.requests.some((request) => request.rpcMethod === "tools/list"),
      compazioToolsDiscovered: [...new Set(advertisedTools)],
      compazioSessionId: input.compazioSessionId,
      workspaceId: input.workspaceId,
      terminalId: input.terminalId,
      capabilities: input.capabilities,
      isCompazio: input.isCompazio,
      toolUse: outputEvents.filter((event) => event.type === "assistant.tool_use"),
      toolResult: input.calls,
      permissionDenials: input.calls.filter((call) => call.ok === false),
      clientEvents: outputEvents.filter((event) => event.type !== "assistant.tool_use"),
      exitCode: input.turn.exitCode,
      timedOut: input.turn.timedOut,
      cleanup: "will-run-in-finally"
    })}\n`
  );
}

function classifyCodexRecruitFailure(
  turn: { readonly output: string; readonly exitCode: number | null; readonly timedOut: boolean },
  calls: readonly CompazioMcpToolCall[]
):
  | "CLIENT_PROVIDER_TIMEOUT"
  | "CLIENT_PROVIDER_OVERLOADED"
  | "CLIENT_NOT_AUTHENTICATED"
  | "UNKNOWN" {
  if (turn.timedOut || /timed out|timeout/i.test(turn.output)) return "CLIENT_PROVIDER_TIMEOUT";
  if (/overloaded|capacity|rate limit/i.test(turn.output)) return "CLIENT_PROVIDER_OVERLOADED";
  if (/not logged in|authenticate|login/i.test(turn.output)) return "CLIENT_NOT_AUTHENTICATED";
  if (calls.some((call) => call.tool === "team_recruit" && !call.ok)) return "UNKNOWN";
  return "UNKNOWN";
}

function classifyClaudeRecruitFailure(
  turn: { readonly output: string; readonly exitCode: number | null; readonly timedOut: boolean },
  requests: readonly CompazioMcpHttpRequest[],
  calls: readonly CompazioMcpToolCall[]
): "A" | "B" | "C" | "D" | "E" | "F" | "G" {
  const listedTools = requests
    .filter((request) => request.rpcMethod === "tools/list")
    .flatMap((request) => request.advertisedTools ?? []);
  if (!listedTools.includes("team_recruit")) return "A";
  const clientCalled = JSON.stringify(safePortalMcpDebugEvents(turn.output)).includes(
    "team_recruit"
  );
  const rejectedCall = calls.find((call) => call.tool === "team_recruit" && call.ok === false);
  if (rejectedCall?.code === "TEAM_CAPABILITY_DENIED") return "E";
  if (rejectedCall !== undefined) return "D";
  if (clientCalled) return "F";
  if (turn.timedOut || turn.exitCode !== 0) return "G";
  return "C";
}

async function resolveRealCommand(
  agentId: "claude-code" | "codex",
  executable: string | undefined
): Promise<{ readonly executable: string; readonly prefixArgs: readonly string[] }> {
  if (executable === undefined) throw new Error(`${agentId} executable missing`);
  if (process.platform !== "win32" || !/\.(cmd|bat|ps1)$/i.test(executable)) {
    return { executable, prefixArgs: [] };
  }
  const npmRoot = dirname(executable);
  if (agentId === "claude-code") {
    const native = join(
      npmRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe"
    );
    await access(native);
    return { executable: native, prefixArgs: [] };
  }
  const entry = join(npmRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
  await access(entry);
  return { executable: await resolveHostNodeExecutable(), prefixArgs: [entry] };
}

async function resolveHostNodeExecutable(): Promise<string> {
  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, process.platform === "win32" ? "node.exe" : "node");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through trusted host PATH entries.
    }
  }
  throw new Error("Node host executable missing for Codex.");
}

async function waitFor<T>(label: string, value: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await value();
    if (current !== undefined) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(
      `COMPAZIO REAL CHECK FAILED: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
