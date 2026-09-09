import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EntitlementError,
  EntitlementService,
  FREE_WORKSPACE_LIMIT_ERROR,
  resolveTestHarnessId,
  writeTestHarnessMarker,
  type EntitlementPayload
} from "./entitlement-service";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createService(now = new Date()): Promise<{
  readonly service: EntitlementService;
  readonly root: string;
  readonly privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  readonly publicKey: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "compazio-license-test-"));
  temporaryRoots.push(root);
  const keys = generateKeyPairSync("ed25519");
  return {
    root,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    service: new EntitlementService({
      statePath: join(root, "license.json"),
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      appVersion: "0.1.0-beta.test",
      now: () => new Date(now)
    })
  };
}

function entitlement(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  installationId: string
): string {
  const payload: EntitlementPayload = {
    schemaVersion: 1,
    keyId: "test",
    plan: "beta_unlimited",
    installationId,
    maxWorkspaces: null,
    issuedAt: "2026-08-01T00:00:00.000Z",
    // Keep the generic signature fixture valid independently of the wall clock. Expiry behavior
    // belongs in dedicated expiry tests, not in every signature/activation test in this file.
    expiresAt: "2099-08-31T00:00:00.000Z",
    activationId: "activation-test",
    licenseVersion: 1
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(null, Buffer.from(encoded), privateKey).toString("base64url");
  return `${encoded}.${signature}`;
}

describe("EntitlementService", () => {
  it("permite o primeiro workspace e nega o segundo sem entitlement", async () => {
    const { service } = await createService();
    await expect(service.assertCanCreateWorkspace(0)).resolves.toBeUndefined();
    await expect(service.assertCanCreateWorkspace(1)).rejects.toMatchObject({
      code: FREE_WORKSPACE_LIMIT_ERROR
    });
  });

  it("desbloqueia workspaces ilimitados com entitlement assinado vinculado à instalação", async () => {
    const { service, privateKey, publicKey } = await createService();
    const installationId = await service.installationId();
    const statePath = (service as unknown as { statePath: string }).statePath;
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        entitlement: entitlement(privateKey, installationId)
      })
    );
    // Use a fresh service instance to simulate a restart after an entitlement was persisted.
    const status = await new EntitlementService({
      statePath,
      publicKeyPem: publicKey,
      appVersion: "0.1.0-beta.test"
    }).status();
    expect(status.plan).toBe("beta_unlimited");
    expect(status.maxWorkspaces).toBeNull();
    await expect(
      new EntitlementService({
        statePath,
        publicKeyPem: publicKey,
        appVersion: "0.1.0-beta.test"
      }).assertCanCreateWorkspace(100)
    ).resolves.toBeUndefined();
  });

  it("não aceita entitlement de outra instalação", async () => {
    const { service, privateKey } = await createService();
    const installationId = await service.installationId();
    const statePath = (service as unknown as { statePath: string }).statePath;
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        entitlement: entitlement(privateKey, "other-installation")
      })
    );
    expect((await service.status()).maxWorkspaces).toBe(1);
    await expect(service.assertCanCreateWorkspace(1)).rejects.toMatchObject({
      code: FREE_WORKSPACE_LIMIT_ERROR
    });
  });

  it("rejects a locally tampered signed entitlement and retains the free limit", async () => {
    const { service, privateKey } = await createService();
    const installationId = await service.installationId();
    const statePath = (service as unknown as { statePath: string }).statePath;
    const signed = entitlement(privateKey, installationId);
    const [encoded, signature] = signed.split(".");
    if (encoded === undefined || signature === undefined) throw new Error("signed fixture missing");
    const alteredPayload = {
      ...JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      maxWorkspaces: 999
    };
    const altered = Buffer.from(JSON.stringify(alteredPayload)).toString("base64url");
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      statePath,
      JSON.stringify({ schemaVersion: 1, installationId, entitlement: `${altered}.${signature}` })
    );
    expect((await service.status()).maxWorkspaces).toBe(1);
    await expect(service.assertCanCreateWorkspace(1)).rejects.toMatchObject({
      code: FREE_WORKSPACE_LIMIT_ERROR
    });
  });

  it("normaliza erros de ativação sem revelar o código", async () => {
    const { service } = await createService();
    await expect(service.activate("CMPZ-NOT-A-REAL-CODE")).rejects.toBeInstanceOf(EntitlementError);
  });

  it("limits refresh calls to once per day", async () => {
    const { service, privateKey, publicKey } = await createService(
      new Date("2026-08-02T12:00:00.000Z")
    );
    const installationId = await service.installationId();
    const statePath = (service as unknown as { statePath: string }).statePath;
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        entitlement: entitlement(privateKey, installationId),
        lastValidatedAt: "2026-08-02T11:30:00.000Z"
      })
    );
    let calls = 0;
    const refreshed = new EntitlementService({
      statePath,
      publicKeyPem: publicKey,
      appVersion: "0.1.0-beta.test",
      now: () => new Date("2026-08-02T12:00:00.000Z"),
      supabaseUrl: "https://example.supabase.co",
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 500 });
      }
    });
    await refreshed.refresh();
    expect(calls).toBe(0);
  });

  it("removes an entitlement after a confirmed server revocation", async () => {
    const { service, privateKey, publicKey } = await createService(
      new Date("2026-08-02T12:00:00.000Z")
    );
    const installationId = await service.installationId();
    const statePath = (service as unknown as { statePath: string }).statePath;
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        entitlement: entitlement(privateKey, installationId),
        lastValidatedAt: "2026-07-01T12:00:00.000Z"
      })
    );
    const refreshed = new EntitlementService({
      statePath,
      publicKeyPem: publicKey,
      appVersion: "0.1.0-beta.test",
      now: () => new Date("2026-08-02T12:00:00.000Z"),
      supabaseUrl: "https://example.supabase.co",
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: "LICENSE_INACTIVE" } }), { status: 403 })
    });
    expect((await refreshed.refresh()).plan).toBe("free");
    expect((await refreshed.status()).maxWorkspaces).toBe(1);
  });

  it("volta ao limite gratuito depois de desativar a licença", async () => {
    const { service, privateKey, publicKey } = await createService();
    const installationId = await service.installationId();
    const statePath = (service as unknown as { statePath: string }).statePath;
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        entitlement: entitlement(privateKey, installationId)
      })
    );
    const licensed = new EntitlementService({
      statePath,
      publicKeyPem: publicKey,
      appVersion: "0.1.0-beta.test"
    });
    expect((await licensed.status()).maxWorkspaces).toBeNull();
    await licensed.deactivate();
    expect((await licensed.status()).plan).toBe("free");
    expect((await licensed.status()).maxWorkspaces).toBe(1);
    await expect(licensed.assertCanCreateWorkspace(1)).rejects.toMatchObject({
      code: FREE_WORKSPACE_LIMIT_ERROR
    });
  });
});

describe("bypass de licença para testes", () => {
  async function harnessRoot(): Promise<{ readonly stateDirectory: string; readonly id: string }> {
    const root = await mkdtemp(join(tmpdir(), "compazio-harness-"));
    temporaryRoots.push(root);
    const stateDirectory = join(root, "state");
    const id = "harness-run-1";
    await writeTestHarnessMarker(stateDirectory, id);
    return { stateDirectory, id };
  }

  function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      NODE_ENV: "test",
      COMPAZIO_TEST_UNLIMITED_WORKSPACES: "1",
      COMPAZIO_TEST_HARNESS_ID: "harness-run-1",
      ...overrides
    };
  }

  it("libera o limite somente com todas as condições do harness isolado", async () => {
    const { stateDirectory, id } = await harnessRoot();
    await expect(
      resolveTestHarnessId({ environment: environment(), stateDirectory, packaged: false })
    ).resolves.toBe(id);
  });

  it("não libera na aplicação empacotada", async () => {
    const { stateDirectory } = await harnessRoot();
    await expect(
      resolveTestHarnessId({ environment: environment(), stateDirectory, packaged: true })
    ).resolves.toBeNull();
  });

  it("não libera em desenvolvimento comum nem em build unpacked manual", async () => {
    const { stateDirectory } = await harnessRoot();
    for (const nodeEnv of ["development", "production", undefined])
      await expect(
        resolveTestHarnessId({
          environment: environment({ NODE_ENV: nodeEnv }),
          stateDirectory,
          packaged: false
        })
      ).resolves.toBeNull();
  });

  it("não libera sem a flag dedicada nem sem o identificador da execução", async () => {
    const { stateDirectory } = await harnessRoot();
    await expect(
      resolveTestHarnessId({
        environment: environment({ COMPAZIO_TEST_UNLIMITED_WORKSPACES: undefined }),
        stateDirectory,
        packaged: false
      })
    ).resolves.toBeNull();
    await expect(
      resolveTestHarnessId({
        environment: environment({ COMPAZIO_TEST_HARNESS_ID: "  " }),
        stateDirectory,
        packaged: false
      })
    ).resolves.toBeNull();
  });

  it("não libera quando o userData não é temporário", async () => {
    const { id } = await harnessRoot();
    const installed = join(process.cwd(), "fake-user-data");
    await expect(
      resolveTestHarnessId({
        environment: environment({ COMPAZIO_TEST_HARNESS_ID: id }),
        stateDirectory: installed,
        packaged: false
      })
    ).resolves.toBeNull();
  });

  it("não libera quando o marcador não pertence a esta execução", async () => {
    const { stateDirectory } = await harnessRoot();
    await expect(
      resolveTestHarnessId({
        environment: environment({ COMPAZIO_TEST_HARNESS_ID: "outra-execucao" }),
        stateDirectory,
        packaged: false
      })
    ).resolves.toBeNull();
  });

  it("não libera quando o harness não deixou marcador algum", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-sem-marcador-"));
    temporaryRoots.push(root);
    await expect(
      resolveTestHarnessId({ environment: environment(), stateDirectory: root, packaged: false })
    ).resolves.toBeNull();
  });

  it("recusa construir um entitlement isolado fora da raiz temporária", () => {
    expect(() =>
      EntitlementService.forIsolatedTest({
        statePath: join(process.cwd(), "license.json"),
        appVersion: "0.0.0-test",
        harnessId: "harness-run-1"
      })
    ).toThrow(EntitlementError);
  });

  it("só o entitlement isolado ignora o limite; o comum continua negando", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-isolated-"));
    temporaryRoots.push(root);
    const isolated = EntitlementService.forIsolatedTest({
      statePath: join(root, "license.json"),
      appVersion: "0.0.0-test",
      harnessId: "harness-run-1"
    });
    await expect(isolated.assertCanCreateWorkspace(9)).resolves.toBeUndefined();
    const normal = new EntitlementService({
      statePath: join(root, "normal.json"),
      appVersion: "0.0.0-test"
    });
    await expect(normal.assertCanCreateWorkspace(1)).rejects.toMatchObject({
      code: FREE_WORKSPACE_LIMIT_ERROR
    });
  });
});
