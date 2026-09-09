import { z } from "zod";

const stableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid stable id");
const timestampSchema = z.iso.datetime();
const envKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const AGENT_CATALOG_SCHEMA_VERSION = 1;

export const agentProviderIdSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "shell",
  "custom"
]);
export type AgentProviderId = z.infer<typeof agentProviderIdSchema>;

export const agentCapabilitySchema = z.enum([
  "interactive",
  "file-read",
  "file-write",
  "shell",
  "custom-instructions",
  "resume-session",
  "non-interactive"
]);
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;

export const agentDefinitionSchema = z
  .object({
    id: stableIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000).optional(),
    icon: z.string().trim().min(1).max(80).optional(),
    executableCandidates: z.array(z.string().trim().min(1).max(1_024)).min(1).max(32),
    defaultArgs: z.array(z.string().max(8_192)).max(64),
    capabilities: z.array(agentCapabilitySchema).min(1),
    supportsRoles: z.boolean(),
    supportsInteractiveTerminal: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export const agentInstallationStatusSchema = z.enum([
  "unknown",
  "checking",
  "installed",
  "not-installed",
  "not-authenticated",
  "invalid",
  "permission-denied",
  "timed-out"
]);
export type AgentInstallationStatus = z.infer<typeof agentInstallationStatusSchema>;

export const agentErrorCodeSchema = z.enum([
  "AGENT_NOT_INSTALLED",
  "AGENT_EXECUTABLE_NOT_FOUND",
  "AGENT_EXECUTABLE_INVALID",
  "AGENT_NOT_AUTHENTICATED",
  "AGENT_SPAWN_FAILED",
  "AGENT_DETECTION_TIMEOUT",
  "AGENT_VERSION_UNAVAILABLE",
  "AGENT_LAUNCH_FAILED",
  "AGENT_CONFIGURATION_INVALID",
  "ROLE_NOT_FOUND",
  "ROLE_INVALID",
  "ROLE_PREPARATION_FAILED",
  "ROLE_IMPORT_CONFLICT",
  "ROLE_CLEANUP_FAILED",
  "PERMISSION_POLICY_UNSUPPORTED",
  "WORKING_DIRECTORY_NOT_FOUND"
]);
export type AgentErrorCode = z.infer<typeof agentErrorCodeSchema>;

export const agentErrorSchema = z
  .object({
    code: agentErrorCodeSchema,
    message: z.string().trim().min(1).max(2_000),
    details: z.string().trim().min(1).max(4_000).optional(),
    suggestedAction: z.string().trim().min(1).max(1_000).optional()
  })
  .strict();
export type AgentError = z.infer<typeof agentErrorSchema>;

export const agentInstallationSchema = z
  .object({
    agentId: stableIdSchema,
    status: agentInstallationStatusSchema,
    executablePath: z.string().trim().min(1).max(4_096).optional(),
    version: z.string().trim().min(1).max(240).optional(),
    detectedAt: timestampSchema.optional(),
    error: agentErrorSchema.optional()
  })
  .strict();
export type AgentInstallation = z.infer<typeof agentInstallationSchema>;

const persistedEnvironmentSchema = z
  .record(envKeySchema, z.string().max(8_192))
  .superRefine((environment, context) => {
    for (const key of Object.keys(environment)) {
      if (/(token|secret|password|api[_-]?key|credential)/i.test(key)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Agent presets cannot persist secrets"
        });
      }
    }
  });

export const agentPresetSchema = z
  .object({
    id: stableIdSchema,
    name: z.string().trim().min(1).max(240),
    agentId: stableIdSchema,
    executable: z.string().trim().min(1).max(4_096).optional(),
    args: z.array(z.string().max(8_192)).max(128),
    env: persistedEnvironmentSchema,
    processMode: z.enum(["auto", "pty", "pipe"]),
    roleId: stableIdSchema.optional(),
    isBuiltIn: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();
export type AgentPreset = z.infer<typeof agentPresetSchema>;

export const agentRoleSchema = z
  .object({
    id: stableIdSchema,
    name: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(1_000).optional(),
    badge: z
      .object({
        label: z.string().trim().min(1).max(80),
        colorToken: z.string().trim().min(1).max(120).optional()
      })
      .strict()
      .optional(),
    instructions: z.string().trim().min(1).max(100_000),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.enum(["built-in", "user", "repository", "generated"]),
    scope: z.enum(["global", "workspace", "repository"]),
    portable: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const roleAssignmentSchema = z
  .object({
    terminalNodeId: stableIdSchema,
    roleId: stableIdSchema,
    appliedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    appliedAt: timestampSchema
  })
  .strict();
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;

export const workspacePermissionPolicySchema = z
  .object({
    fileAccess: z.enum(["ask", "workspace-read", "workspace-read-write"]),
    destructiveActions: z.enum(["always-ask", "allow-in-workspace"]),
    externalPaths: z.literal("always-ask"),
    networkAccess: z.enum(["agent-default", "restricted"])
  })
  .strict();
export type WorkspacePermissionPolicy = z.infer<typeof workspacePermissionPolicySchema>;

export const terminalAgentConfigSchema = z
  .object({
    agentId: stableIdSchema,
    presetId: stableIdSchema.optional(),
    roleId: stableIdSchema.optional()
  })
  .strict();
export type TerminalAgentConfig = z.infer<typeof terminalAgentConfigSchema>;

export const agentCatalogSchema = z
  .object({
    schemaVersion: z.literal(AGENT_CATALOG_SCHEMA_VERSION),
    customDefinitions: z.array(agentDefinitionSchema),
    presets: z.array(agentPresetSchema),
    roles: z.array(agentRoleSchema),
    installations: z.array(agentInstallationSchema),
    manualExecutablePaths: z.record(stableIdSchema, z.string().trim().min(1).max(4_096)),
    updatedAt: timestampSchema
  })
  .strict();
export type AgentCatalog = z.infer<typeof agentCatalogSchema>;

export const agentSessionStatusSchema = z.enum([
  "configuration-invalid",
  "agent-not-installed",
  "preparing-role",
  "waiting-start",
  "starting",
  "running",
  "stopping",
  "completed",
  "failed",
  "disconnected"
]);
export type AgentSessionStatus = z.infer<typeof agentSessionStatusSchema>;

export interface AgentLaunchRequest {
  readonly workspaceId: string;
  readonly terminalNodeId: string;
  readonly agentId: string;
  readonly presetId?: string;
  readonly workingDirectory: string;
  readonly roleId?: string;
  readonly executableOverride?: string;
  readonly argsOverride?: readonly string[];
  readonly envOverrides?: Readonly<Record<string, string>>;
  readonly processModeOverride?: "auto" | "pty" | "pipe";
}

export function defaultWorkspacePermissionPolicy(): WorkspacePermissionPolicy {
  return {
    fileAccess: "ask",
    destructiveActions: "always-ask",
    externalPaths: "always-ask",
    networkAccess: "agent-default"
  };
}

export function defaultTerminalAgentConfig(): TerminalAgentConfig {
  return { agentId: "shell" };
}

export function roleRevision(instructions: string): string {
  // A deterministic, serializable revision marker. Cryptographic verification is intentionally not
  // part of the local role format; this only detects that instructions changed before relaunch.
  const values = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  for (let index = 0; index < instructions.length; index += 1) {
    const code = instructions.charCodeAt(index);
    for (let offset = 0; offset < values.length; offset += 1) {
      const current = values[offset] ?? 0;
      values[offset] = Math.imul(current ^ (code + offset * 17), 0x01000193) >>> 0;
    }
  }
  return values
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("")
    .repeat(2);
}

export function createBuiltInAgentDefinitions(now: string): readonly AgentDefinition[] {
  const stamp = { createdAt: now, updatedAt: now };
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      description: "CLI interativa instalada pelo usuário.",
      icon: "Claude",
      executableCandidates: ["claude", "claude.cmd", "claude.exe"],
      defaultArgs: [],
      capabilities: ["interactive", "file-read", "file-write", "shell", "custom-instructions"],
      supportsRoles: true,
      supportsInteractiveTerminal: true,
      ...stamp
    },
    {
      id: "codex",
      name: "Codex",
      description: "CLI interativa instalada pelo usuário.",
      icon: "Codex",
      executableCandidates: ["codex", "codex.cmd", "codex.exe"],
      defaultArgs: [],
      capabilities: ["interactive", "file-read", "file-write", "shell", "custom-instructions"],
      supportsRoles: true,
      supportsInteractiveTerminal: true,
      ...stamp
    },
    {
      id: "opencode",
      name: "OpenCode",
      description: "CLI interativa instalada pelo usuário.",
      icon: "OpenCode",
      executableCandidates: ["opencode", "opencode.cmd", "opencode.exe"],
      defaultArgs: [],
      capabilities: ["interactive", "file-read", "file-write", "shell", "custom-instructions"],
      supportsRoles: true,
      supportsInteractiveTerminal: true,
      ...stamp
    },
    {
      id: "shell",
      name: "Shell padrão",
      description: "Shell local sem agente de IA.",
      icon: "Terminal",
      executableCandidates: ["pwsh.exe", "powershell.exe", "cmd.exe", "sh"],
      defaultArgs: [],
      capabilities: ["interactive", "shell"],
      supportsRoles: false,
      supportsInteractiveTerminal: true,
      ...stamp
    },
    {
      id: "custom",
      name: "Comando personalizado",
      description: "Executável e argumentos configurados pelo usuário.",
      icon: "Command",
      executableCandidates: ["custom"],
      defaultArgs: [],
      capabilities: ["interactive", "shell", "custom-instructions"],
      supportsRoles: true,
      supportsInteractiveTerminal: true,
      ...stamp
    }
  ].map((definition) => agentDefinitionSchema.parse(definition));
}

export function createBuiltInRoles(now: string): readonly AgentRole[] {
  const build = (
    id: string,
    name: string,
    description: string,
    label: string,
    instructions: string
  ): AgentRole =>
    agentRoleSchema.parse({
      id,
      name,
      description,
      badge: { label, colorToken: `role.${id}` },
      instructions,
      revision: roleRevision(instructions),
      source: "built-in",
      scope: "global",
      portable: false,
      createdAt: now,
      updatedAt: now
    });
  return [
    build(
      "developer",
      "Desenvolvedor",
      "Implementa somente o escopo solicitado.",
      "Dev",
      "Implemente somente o escopo solicitado. Respeite a arquitetura existente, execute validações relevantes e evite alterações não relacionadas."
    ),
    build(
      "reviewer",
      "Revisor",
      "Revisa código e comportamento procurando regressões.",
      "Review",
      "Revise código e comportamento. Procure regressões e apresente problemas concretos; não reescreva tudo sem necessidade."
    ),
    build(
      "tester",
      "Testador",
      "Cria e executa testes para reproduzir falhas.",
      "Test",
      "Crie e execute testes, reproduza falhas quando existirem e documente cobertura e limitações reais."
    ),
    build(
      "documentation",
      "Documentação",
      "Mantém a documentação alinhada ao código.",
      "Docs",
      "Atualize a documentação relevante sem inventar comportamentos; reflita o estado real do código e suas limitações."
    ),
    build(
      "ui-designer",
      "Designer de Interface",
      "Trabalha em experiência, consistência e acessibilidade.",
      "UI",
      "Trabalhe em experiência, consistência e acessibilidade. Respeite o design system e evite mudanças de backend sem necessidade."
    )
  ];
}

export function defaultAgentCatalog(now: string): AgentCatalog {
  return agentCatalogSchema.parse({
    schemaVersion: AGENT_CATALOG_SCHEMA_VERSION,
    customDefinitions: [],
    presets: createBuiltInAgentDefinitions(now).map((definition) => ({
      id: `preset-${definition.id}`,
      name: definition.name,
      agentId: definition.id,
      args: definition.defaultArgs,
      env: {},
      processMode: "auto",
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now
    })),
    roles: [...createBuiltInRoles(now)],
    installations: [],
    manualExecutablePaths: {},
    updatedAt: now
  });
}
