import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildTerminalPromptDelivery, ConnectionBroker } from "./connection-broker";
import type { ConnectionBrokerError } from "./connection-broker";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ConnectionBroker", () => {
  it("persiste a solicitação e acorda --wait somente depois de reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-connections-"));
    roots.push(root);
    let sequence = 0;
    const broker = new ConnectionBroker({
      storageDirectory: root,
      createId: () => String(++sequence),
      now: () => `2026-08-13T00:00:0${sequence}.000Z`
    });
    const request = await broker.create({
      workspaceId: "workspace-1",
      edgeId: "edge-1",
      sourceTerminalId: "claude",
      targetTerminalId: "codex",
      message: "Revise o README"
    });
    await broker.markDelivered("workspace-1", request.id);
    const waiting = broker.waitForResponse("workspace-1", request.id, 1_000);
    await expect(broker.inbox("workspace-1", "codex")).resolves.toHaveLength(1);
    await broker.reply({
      workspaceId: "workspace-1",
      requestId: request.id,
      actorTerminalId: "codex",
      response: "1. Simplifique a introdução"
    });
    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      request: { status: "responded", response: "1. Simplifique a introdução" }
    });
    const persisted = await readFile(join(root, "connection-requests", "workspace-1.json"), "utf8");
    expect(persisted).toContain('"status": "responded"');
  });

  it("torna reply idempotente e rejeita outro destinatário", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-connections-auth-"));
    roots.push(root);
    const broker = new ConnectionBroker({ storageDirectory: root, createId: () => "1" });
    const request = await broker.create({
      workspaceId: "workspace-1",
      edgeId: "edge-1",
      sourceTerminalId: "claude",
      targetTerminalId: "codex",
      message: "Teste"
    });
    await expect(
      broker.reply({
        workspaceId: "workspace-1",
        requestId: request.id,
        actorTerminalId: "claude",
        response: "indevida"
      })
    ).rejects.toMatchObject<Partial<ConnectionBrokerError>>({ code: "REPLY_PERMISSION_DENIED" });
    const input = {
      workspaceId: "workspace-1",
      requestId: request.id,
      actorTerminalId: "codex",
      response: "ok"
    } as const;
    await broker.reply(input);
    await expect(broker.reply(input)).resolves.toMatchObject({ response: "ok" });
  });

  it("gera um frame de paste e um submit separados e remove controles injetados", () => {
    const delivery = buildTerminalPromptDelivery({
      requestId: "request-1",
      sourceTitle: "Claude\u001b[31m",
      message: "linha 1\u001b[201~\nlinha 2"
    });
    expect(delivery.pasteFrame.startsWith("\u001b[200~")).toBe(true);
    expect(delivery.pasteFrame.endsWith("\u001b[201~")).toBe(true);
    expect(delivery.pasteFrame.split("\u001b[200~")).toHaveLength(2);
    expect(delivery.pasteFrame.split("\u001b[201~")).toHaveLength(2);
    expect(delivery.pasteFrame).toContain("compazio reply request-1");
    expect(delivery.submit).toBe("\r");
  });

  it("torna create idempotente por request id e rejeita reutilização conflitante", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-connections-idempotent-"));
    roots.push(root);
    const broker = new ConnectionBroker({ storageDirectory: root });
    const input = {
      workspaceId: "workspace-1",
      edgeId: "edge-1",
      sourceTerminalId: "claude",
      targetTerminalId: "codex",
      message: "Revise",
      requestId: "request-stable"
    } as const;
    const first = await broker.create(input);
    await expect(broker.create(input)).resolves.toEqual(first);
    await expect(broker.create({ ...input, message: "Outra tarefa" })).rejects.toMatchObject<
      Partial<ConnectionBrokerError>
    >({ code: "REQUEST_ID_CONFLICT" });
  });

  it("recupera a caixa postal do backup atômico quando o arquivo principal corrompe", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-connections-recovery-"));
    roots.push(root);
    let sequence = 0;
    const broker = new ConnectionBroker({
      storageDirectory: root,
      createId: () => String(++sequence)
    });
    await broker.create({
      workspaceId: "workspace-1",
      edgeId: "edge-1",
      sourceTerminalId: "claude",
      targetTerminalId: "codex",
      message: "Primeira"
    });
    await broker.create({
      workspaceId: "workspace-1",
      edgeId: "edge-1",
      sourceTerminalId: "claude",
      targetTerminalId: "codex",
      message: "Segunda"
    });
    const path = join(root, "connection-requests", "workspace-1.json");
    await writeFile(path, "{corrompido", "utf8");

    const recovered = new ConnectionBroker({ storageDirectory: root });
    await expect(recovered.inbox("workspace-1", "codex")).resolves.toMatchObject([
      { message: "Primeira" }
    ]);
  });

  it("aplica o limite de 32 KB em bytes e permite cancelamento somente pelo remetente", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-connections-limits-"));
    roots.push(root);
    const broker = new ConnectionBroker({ storageDirectory: root, createId: () => "1" });
    await expect(
      broker.create({
        workspaceId: "workspace-1",
        edgeId: "edge-1",
        sourceTerminalId: "claude",
        targetTerminalId: "codex",
        message: "😀".repeat(9_000)
      })
    ).rejects.toMatchObject<Partial<ConnectionBrokerError>>({ code: "MESSAGE_TOO_LARGE" });
    const request = await broker.create({
      workspaceId: "workspace-1",
      edgeId: "edge-1",
      sourceTerminalId: "claude",
      targetTerminalId: "codex",
      message: "Pode cancelar"
    });
    await expect(broker.cancel("workspace-1", request.id, "codex")).rejects.toMatchObject<
      Partial<ConnectionBrokerError>
    >({ code: "CANCEL_PERMISSION_DENIED" });
    await expect(broker.cancel("workspace-1", request.id, "claude")).resolves.toMatchObject({
      status: "cancelled"
    });
  });
});
