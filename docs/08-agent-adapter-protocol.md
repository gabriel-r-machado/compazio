# Protocolo de adapters de agentes

## Motivação

CLIs mudam flags, formatos e recursos. O core não deve saber detalhes de Claude Code ou Codex.

## Contrato

```ts
export interface AgentAdapter {
  manifest: AgentManifest;
  detect(ctx: DetectContext): Promise<DetectionResult>;
  validateAuth(ctx: AuthContext): Promise<AuthResult>;
  buildLaunch(input: LaunchInput): Promise<LaunchSpec>;
  parseOutput(chunk: OutputChunk, state: ParserState): ParseResult;
  sendMessage(session: SessionHandle, message: AgentMessage): Promise<void>;
  requestStop(session: SessionHandle): Promise<void>;
  forceKill(session: SessionHandle): Promise<void>;
  buildResume?(input: ResumeInput): Promise<LaunchSpec>;
  summarizeSession?(input: SessionSummaryInput): Promise<SessionSummary>;
}
```

## Manifest

```ts
interface AgentManifest {
  id: string;
  displayName: string;
  version: string;
  executableCandidates: string[];
  supportedPlatforms: Array<"win32" | "darwin" | "linux">;
  capabilities: {
    interactive: boolean;
    nonInteractive: boolean;
    resume: boolean;
    structuredOutput: boolean;
    mcp: boolean;
    imageInput: boolean;
  };
  permissions: PermissionDescriptor[];
}
```

## Estratégia de integração

Ordem de preferência:

1. modo não interativo com output estruturado oficial;
2. modo interativo PTY com marcadores confiáveis;
3. parsing heurístico limitado e observável.

Nunca basear sucesso apenas na frase produzida pelo agente. Sucesso depende de:

- exit code;
- artefato;
- gate;
- condição explícita.

## Segurança

- executar com cwd específico;
- environment allowlist;
- redigir variáveis sensíveis em logs;
- não concatenar shell string quando houver API de args;
- validar executable path;
- informar permissões;
- confirmar comandos destrutivos.

## Adapters P0

### shell

Adapter de referência e base dos testes.

### claude-code

Usa instalação/autenticação já existente. Implementar detecção, launch, cancelamento, resume somente quando suportado de forma confiável.

### codex

Mesma abordagem: pass-through para o CLI instalado.

### opencode

Mesma abordagem: pass-through para o CLI instalado, por `opencode run`, seu modo não interativo
oficial. O prompt chega inteiro pelo stdin e nunca pelo argv; como OpenCode não tem equivalente a
`--output-last-message`, o resultado oficial é um arquivo controlado no staging gerenciado da run,
nomeado no ambiente e no prompt. O bypass de permissões do CLI nunca é usado.

Os três adapters — `claude-code`, `codex` e `opencode` — executam nós single-shot pelo mesmo caminho
(`node.adapter` → registry → adapter → `ProcessAgentNodeExecutor` → `ProcessSupervisor` → pipe →
artefato oficial → `WorkflowRunRuntime`) e foram validados contra os CLIs reais instalados e
autenticados pelo usuário, por checks opt-in fora dos gates.

Ainda não existem: porta de orquestrador para Codex e OpenCode (somente Claude planeja), sessão de
terminal interativo para OpenCode e qualquer fallback automático entre adapters durante uma run.

## Adapter test kit

Cada adapter precisa passar:

- detect installed;
- detect missing;
- invalid auth;
- spawn;
- output burst;
- resize;
- queue input;
- graceful stop;
- force kill;
- unexpected exit;
- path with spaces;
- Windows shell;
- sanitization.
