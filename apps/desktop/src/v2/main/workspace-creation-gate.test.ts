import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";
import {
  AgentRuntime,
  RoleInjectionService,
  V2ProcessSupervisor
} from "@forgedeck/compazio-v2-runtime";
import { V2_WORKSPACE_CREATE_CHANNEL } from "@forgedeck/compazio-v2-domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EntitlementService,
  FREE_WORKSPACE_LIMIT_ERROR,
  type EntitlementPayload
} from "./entitlement-service";
import { registerV2Ipc, type V2IpcServices } from "./v2-ipc";
import { V2WorkspaceService } from "./workspace-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scenario(): Promise<{
  readonly root: string;
  readonly service: V2WorkspaceService;
  readonly entitlement: EntitlementService;
  readonly repository: V2WorkspaceRepository;
  readonly grantLicense: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "compazio-gate-"));
  roots.push(root);
  const repository = new V2WorkspaceRepository({ rootDirectory: root });
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const statePath = join(root, "license", "entitlement.json");
  // A plain service, exactly as the installed desktop builds it: no isolated-test factory here.
  const entitlement = new EntitlementService({
    statePath,
    publicKeyPem,
    appVersion: "0.1.0-beta.test"
  });
  const supervisor = new V2ProcessSupervisor(
    { spawn: vi.fn(async () => ({}) as never) },
    { treeKiller: { kill: vi.fn(async () => undefined) } }
  );
  const service = new V2WorkspaceService({
    repository,
    supervisor,
    agents: new AgentRuntime({
      store: repository,
      roleInjection: new RoleInjectionService(join(root, "role-sessions"))
    }),
    entitlement
  });
  return {
    root,
    service,
    entitlement,
    repository,
    grantLicense: async () => {
      const installationId = await entitlement.installationId();
      const payload: EntitlementPayload = {
        schemaVersion: 1,
        keyId: "test",
        plan: "beta_unlimited",
        installationId,
        maxWorkspaces: null,
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        activationId: "activation-test",
        licenseVersion: 1
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = sign(null, Buffer.from(encoded), keys.privateKey).toString("base64url");
      await writeFile(
        statePath,
        JSON.stringify({ schemaVersion: 1, installationId, entitlement: `${encoded}.${signature}` })
      );
      // Drops the cached state so the next read picks the entitlement just written.
      (entitlement as unknown as { state: null }).state = null;
    }
  };
}

describe("gate de criação de workspace", () => {
  it("permite a primeira criação gratuita e nega a segunda", async () => {
    const { service } = await scenario();
    await expect(
      service.create({ name: "Primeiro", workingDirectory: process.cwd() })
    ).resolves.toMatchObject({ name: "Primeiro" });
    await expect(
      service.create({ name: "Segundo", workingDirectory: process.cwd() })
    ).rejects.toMatchObject({ code: FREE_WORKSPACE_LIMIT_ERROR });
  });

  it("não grava nada no repositório quando a criação é negada", async () => {
    const { service, root, repository } = await scenario();
    await service.create({ name: "Primeiro", workingDirectory: process.cwd() });
    await expect(
      service.create({ name: "Segundo", workingDirectory: process.cwd() })
    ).rejects.toThrow();
    expect((await repository.list()).workspaces).toHaveLength(1);
    expect(
      (await readdir(join(root, "workspaces"))).filter((f) => f.endsWith(".json"))
    ).toHaveLength(1);
  });

  it("nega a segunda criação vinda do IPC, pelo mesmo gate", async () => {
    const { service } = await scenario();
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    registerV2Ipc(
      {
        handle: (
          channel: string,
          handler: (event: unknown, payload: unknown) => Promise<unknown>
        ) => handlers.set(channel, handler),
        removeHandler: (channel: string) => handlers.delete(channel)
      } as unknown as Parameters<typeof registerV2Ipc>[0],
      { workspaces: service } as unknown as V2IpcServices
    );
    const create = handlers.get(V2_WORKSPACE_CREATE_CHANNEL);
    expect(create).toBeDefined();
    await expect(
      create?.(null, { name: "Primeiro", workingDirectory: process.cwd() })
    ).resolves.toMatchObject({ name: "Primeiro" });
    await expect(
      create?.(null, { name: "Segundo", workingDirectory: process.cwd() })
    ).rejects.toThrow(/FREE_WORKSPACE_LIMIT_REACHED|limite|licen/i);
  });

  it("does not register an arbitrary privileged IPC operation", async () => {
    const { service } = await scenario();
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    registerV2Ipc(
      {
        handle: (
          channel: string,
          handler: (event: unknown, payload: unknown) => Promise<unknown>
        ) => handlers.set(channel, handler),
        removeHandler: (channel: string) => handlers.delete(channel)
      } as unknown as Parameters<typeof registerV2Ipc>[0],
      { workspaces: service } as unknown as V2IpcServices
    );
    expect(handlers.get("compazio-v2:privileged:arbitrary")).toBeUndefined();
    expect(handlers.get("shell:exec")).toBeUndefined();
  });

  it("uma licença válida libera criações além do limite e a desativação restaura o limite", async () => {
    const { service, entitlement, grantLicense } = await scenario();
    await service.create({ name: "Primeiro", workingDirectory: process.cwd() });
    await grantLicense();
    expect((await entitlement.status()).maxWorkspaces).toBeNull();
    await expect(
      service.create({ name: "Segundo", workingDirectory: process.cwd() })
    ).resolves.toMatchObject({ name: "Segundo" });
    await expect(
      service.create({ name: "Terceiro", workingDirectory: process.cwd() })
    ).resolves.toMatchObject({ name: "Terceiro" });

    await entitlement.deactivate();
    expect((await entitlement.status()).maxWorkspaces).toBe(1);
    await expect(
      service.create({ name: "Quarto", workingDirectory: process.cwd() })
    ).rejects.toMatchObject({ code: FREE_WORKSPACE_LIMIT_ERROR });
  });

  it("mantém acessíveis os workspaces históricos criados antes do gate", async () => {
    const { service, entitlement, grantLicense } = await scenario();
    await grantLicense();
    const created = [];
    for (const name of ["Um", "Dois", "Três"])
      created.push(await service.create({ name, workingDirectory: process.cwd() }));
    await entitlement.deactivate();

    // Sem licença e acima do limite: os existentes continuam listáveis, abríveis e editáveis.
    const listing = await service.list();
    expect(listing.workspaces).toHaveLength(3);
    for (const workspace of created) {
      const opened = await service.open(workspace.id);
      expect(opened.id).toBe(workspace.id);
    }
    const first = created[0];
    if (first === undefined) throw new Error("fixture ausente");
    const renamed = await service.rename(first.id, "Um renomeado");
    expect(renamed.name).toBe("Um renomeado");
    await expect(
      service.create({ name: "Novo", workingDirectory: process.cwd() })
    ).rejects.toMatchObject({ code: FREE_WORKSPACE_LIMIT_ERROR });
  });
});

describe("nenhum fluxo escapa do gate", () => {
  const sourceOf = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  it("V2WorkspaceService.create é a única gravação persistente de workspace", () => {
    // Só o serviço pode chamar repository.create; qualquer outro caminho ignoraria o gate.
    for (const file of [
      "./compazio-mcp-gateway.ts",
      "./team-coordinator.ts",
      "./orchestrator-bridge.ts",
      "./v2-ipc.ts",
      "./operational-service.ts"
    ])
      expect(sourceOf(file)).not.toMatch(/repository\.create\s*\(/);
    expect(sourceOf("./workspace-service.ts")).toMatch(
      /this\.options\.repository\.create\(workspace\)/
    );
  });

  it("o gate roda antes de qualquer gravação em create", () => {
    const source = sourceOf("./workspace-service.ts");
    const gate = source.indexOf("entitlement.assertCanCreateWorkspace");
    const write = source.indexOf("repository.create(workspace)");
    expect(gate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(gate);
    // Sem `?.`: um entitlement ausente passa a ser erro de tipo, não um gate silenciosamente pulado.
    expect(source).not.toMatch(/entitlement\?\.assertCanCreateWorkspace/);
  });

  it("Compazio e agentes reais não têm ferramenta de criar workspace", () => {
    const gateway = sourceOf("./compazio-mcp-gateway.ts");
    expect(gateway).not.toMatch(/workspace_create|workspaces\.create\s*\(/);
    expect(sourceOf("./team-coordinator.ts")).not.toMatch(/workspaces\.create\s*\(/);
    expect(sourceOf("./orchestrator-bridge.ts")).not.toMatch(/workspaces\.create\s*\(/);
  });

  it("não existe flag global capaz de liberar o limite por acidente", () => {
    const service = sourceOf("./entitlement-service.ts");
    expect(service).not.toMatch(/allowTestUnlimited/);
    // COMPAZIO_V2_SMOKE controla janela e throttling; nunca pode voltar a controlar a licença.
    expect(sourceOf("./index.ts")).not.toMatch(
      /COMPAZIO_V2_SMOKE[\s\S]{0,200}forIsolatedTest|allowTestUnlimited/
    );
    // O bypass depende de um símbolo não exportado: nenhum chamador externo consegue produzi-lo.
    expect(service).toMatch(/const ISOLATED_TEST_TOKEN = Symbol\(/);
    expect(service).not.toMatch(/export const ISOLATED_TEST_TOKEN/);
    expect(service).toMatch(/this\.testUnlimited = token === ISOLATED_TEST_TOKEN/);
  });
});
