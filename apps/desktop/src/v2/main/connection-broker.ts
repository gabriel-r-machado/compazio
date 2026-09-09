import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { readFileWithRecovery, writeFileAtomically } from "@forgedeck/compazio-v2-persistence";

const maximumMessageBytes = 32 * 1024;
const maximumEnvelopeBytes = 32 * 1024;

const connectionRequestStatusSchema = z.enum([
  "queued",
  "delivered",
  "responded",
  "failed",
  "cancelled"
]);

const stableIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);

export const connectionRequestSchema = z
  .object({
    id: stableIdSchema,
    workspaceId: stableIdSchema,
    edgeId: stableIdSchema,
    sourceTerminalId: stableIdSchema,
    targetTerminalId: stableIdSchema,
    message: z.string().min(1).max(32_000),
    status: connectionRequestStatusSchema,
    createdAt: z.iso.datetime(),
    deliveredAt: z.iso.datetime().optional(),
    respondedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    response: z.string().max(64_000).optional(),
    failure: z.string().max(2_000).optional()
  })
  .strict();

export type ConnectionRequest = z.infer<typeof connectionRequestSchema>;
export type ConnectionRequestStatus = z.infer<typeof connectionRequestStatusSchema>;
export interface ConnectionResponse {
  readonly requestId: string;
  readonly actorTerminalId: string;
  readonly content: string;
  readonly respondedAt: string;
}

const connectionRequestFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: stableIdSchema,
    requests: z.array(connectionRequestSchema).max(10_000)
  })
  .strict();

interface ConnectionBrokerOptions {
  readonly storageDirectory: string;
  readonly createId?: () => string;
  readonly now?: () => string;
}

/**
 * Small durable mailbox for messages carried by visual terminal connections.
 *
 * It deliberately knows nothing about providers or agent frameworks. The bridge authenticates the
 * caller and checks the canvas capability; this class only owns durable request/reply state.
 */
export class ConnectionBroker {
  private readonly rootDirectory: string;
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly cache = new Map<string, readonly ConnectionRequest[]>();
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Set<(request: ConnectionRequest) => void>>();

  public constructor(options: ConnectionBrokerOptions) {
    this.rootDirectory = join(options.storageDirectory, "connection-requests");
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async create(input: {
    readonly workspaceId: string;
    readonly edgeId: string;
    readonly sourceTerminalId: string;
    readonly targetTerminalId: string;
    readonly message: string;
    readonly requestId?: string;
  }): Promise<ConnectionRequest> {
    const message = normalizeMessage(input.message);
    return this.mutate(input.workspaceId, async (requests) => {
      const id = input.requestId ?? `request-${this.createId()}`;
      const existing = requests.find((candidate) => candidate.id === id);
      if (existing !== undefined) {
        if (
          existing.edgeId !== input.edgeId ||
          existing.sourceTerminalId !== input.sourceTerminalId ||
          existing.targetTerminalId !== input.targetTerminalId ||
          existing.message !== message
        ) {
          throw new ConnectionBrokerError(
            "REQUEST_ID_CONFLICT",
            "O request id já pertence a outra mensagem."
          );
        }
        return { requests, result: existing };
      }
      const request = connectionRequestSchema.parse({
        id,
        workspaceId: input.workspaceId,
        edgeId: input.edgeId,
        sourceTerminalId: input.sourceTerminalId,
        targetTerminalId: input.targetTerminalId,
        message,
        status: "queued",
        createdAt: this.now()
      });
      return { requests: [...requests, request].slice(-10_000), result: request };
    });
  }

  public async markDelivered(workspaceId: string, requestId: string): Promise<ConnectionRequest> {
    return this.transition(workspaceId, requestId, (request) => {
      if (request.status !== "queued") return request;
      return { ...request, status: "delivered", deliveredAt: this.now() };
    });
  }

  public async fail(
    workspaceId: string,
    requestId: string,
    failure: string
  ): Promise<ConnectionRequest> {
    return this.transition(workspaceId, requestId, (request) => {
      if (["responded", "cancelled"].includes(request.status)) return request;
      return {
        ...request,
        status: "failed",
        failure: failure.trim().slice(0, 2_000),
        completedAt: this.now()
      };
    });
  }

  public async cancel(
    workspaceId: string,
    requestId: string,
    actorTerminalId: string
  ): Promise<ConnectionRequest> {
    return this.transition(workspaceId, requestId, (request) => {
      if (request.sourceTerminalId !== actorTerminalId) {
        throw new ConnectionBrokerError(
          "CANCEL_PERMISSION_DENIED",
          "Somente o terminal remetente pode cancelar esta solicitação."
        );
      }
      if (request.status === "cancelled") return request;
      if (request.status === "responded" || request.status === "failed") {
        throw new ConnectionBrokerError(
          "REQUEST_NOT_ACTIVE",
          "Esta solicitação não pode mais ser cancelada."
        );
      }
      return { ...request, status: "cancelled", completedAt: this.now() };
    });
  }

  public async reply(input: {
    readonly workspaceId: string;
    readonly requestId: string;
    readonly actorTerminalId: string;
    readonly response: string;
  }): Promise<ConnectionRequest> {
    const response = normalizeResponse(input.response);
    return this.transition(input.workspaceId, input.requestId, (request) => {
      if (request.targetTerminalId !== input.actorTerminalId) {
        throw new ConnectionBrokerError(
          "REPLY_PERMISSION_DENIED",
          "Somente o terminal destinatário pode responder esta solicitação."
        );
      }
      if (request.status === "responded") {
        if (request.response === response) return request;
        throw new ConnectionBrokerError(
          "REQUEST_ALREADY_RESPONDED",
          "Esta solicitação já recebeu outra resposta."
        );
      }
      if (request.status === "failed" || request.status === "cancelled") {
        throw new ConnectionBrokerError(
          "REQUEST_NOT_ACTIVE",
          "Esta solicitação não aceita mais respostas."
        );
      }
      const now = this.now();
      return {
        ...request,
        status: "responded",
        response,
        respondedAt: now,
        completedAt: now
      };
    });
  }

  public async inbox(
    workspaceId: string,
    terminalId: string
  ): Promise<readonly ConnectionRequest[]> {
    return (await this.load(workspaceId))
      .filter(
        (request) =>
          request.targetTerminalId === terminalId &&
          (request.status === "queued" || request.status === "delivered")
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public async get(workspaceId: string, requestId: string): Promise<ConnectionRequest> {
    const request = (await this.load(workspaceId)).find((candidate) => candidate.id === requestId);
    if (request === undefined) {
      throw new ConnectionBrokerError("REQUEST_NOT_FOUND", "Solicitação não encontrada.");
    }
    return request;
  }

  public async waitForResponse(
    workspaceId: string,
    requestId: string,
    timeoutMs: number
  ): Promise<{ readonly request: ConnectionRequest; readonly timedOut: boolean }> {
    const current = await this.get(workspaceId, requestId);
    if (current.status !== "queued" && current.status !== "delivered") {
      return { request: current, timedOut: false };
    }
    return new Promise((resolve) => {
      const waiterKey = this.waiterKey(workspaceId, requestId);
      const listeners = this.waiters.get(waiterKey) ?? new Set();
      const finish = (request: ConnectionRequest, timedOut: boolean): void => {
        clearTimeout(timer);
        listeners.delete(onChange);
        if (listeners.size === 0) this.waiters.delete(waiterKey);
        resolve({ request, timedOut });
      };
      const onChange = (request: ConnectionRequest): void => {
        if (request.status === "queued" || request.status === "delivered") return;
        finish(request, false);
      };
      const timer = setTimeout(() => {
        void this.get(workspaceId, requestId).then((request) => finish(request, true));
      }, timeoutMs);
      listeners.add(onChange);
      this.waiters.set(waiterKey, listeners);
    });
  }

  private async transition(
    workspaceId: string,
    requestId: string,
    change: (request: ConnectionRequest) => ConnectionRequest
  ): Promise<ConnectionRequest> {
    const changed = await this.mutate(workspaceId, async (requests) => {
      const index = requests.findIndex((candidate) => candidate.id === requestId);
      if (index < 0) {
        throw new ConnectionBrokerError("REQUEST_NOT_FOUND", "Solicitação não encontrada.");
      }
      const current = requests[index];
      if (current === undefined) throw new Error("Connection request index became invalid");
      const next = connectionRequestSchema.parse(change(current));
      const updated = [...requests];
      updated[index] = next;
      return { requests: updated, result: next };
    });
    for (const listener of this.waiters.get(this.waiterKey(workspaceId, requestId)) ?? [])
      listener(changed);
    return changed;
  }

  private async load(workspaceId: string): Promise<readonly ConnectionRequest[]> {
    const cached = this.cache.get(workspaceId);
    if (cached !== undefined) return cached;
    const recovered = await readFileWithRecovery(this.pathFor(workspaceId), {
      operation: "loadConnectionRequests",
      parse: (raw) => connectionRequestFileSchema.parse(JSON.parse(raw) as unknown).requests,
      whenMissing: () => []
    });
    const requests = recovered.value;
    this.cache.set(workspaceId, requests);
    return requests;
  }

  private async mutate<T>(
    workspaceId: string,
    mutation: (
      requests: readonly ConnectionRequest[]
    ) => Promise<{ readonly requests: readonly ConnectionRequest[]; readonly result: T }>
  ): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const previous = this.mutationTails.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          const current = await this.load(workspaceId);
          const outcome = await mutation(current);
          await this.save(workspaceId, outcome.requests);
          resolveResult(outcome.result);
        } catch (error) {
          rejectResult(error);
        }
      });
    this.mutationTails.set(workspaceId, next);
    void next.finally(() => {
      if (this.mutationTails.get(workspaceId) === next) this.mutationTails.delete(workspaceId);
    });
    return result;
  }

  private async save(workspaceId: string, requests: readonly ConnectionRequest[]): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    const parsed = connectionRequestFileSchema.parse({
      schemaVersion: 1,
      workspaceId,
      requests
    });
    const target = this.pathFor(workspaceId);
    await writeFileAtomically(target, `${JSON.stringify(parsed, null, 2)}\n`, {
      operation: "saveConnectionRequests",
      keepBackup: true
    });
    this.cache.set(workspaceId, parsed.requests);
  }

  private pathFor(workspaceId: string): string {
    stableIdSchema.parse(workspaceId);
    return join(this.rootDirectory, `${workspaceId}.json`);
  }

  private waiterKey(workspaceId: string, requestId: string): string {
    return `${workspaceId}\u0000${requestId}`;
  }
}

export class ConnectionBrokerError extends Error {
  public constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ConnectionBrokerError";
  }
}

export interface TerminalPromptDelivery {
  readonly pasteFrame: string;
  readonly submit: "\r";
}

export function buildTerminalPromptDelivery(input: {
  readonly requestId: string;
  readonly sourceTitle: string;
  readonly message: string;
}): TerminalPromptDelivery {
  const source = sanitizeTerminalText(input.sourceTitle).replace(/\s+/g, " ").slice(0, 240);
  const message = normalizeMessage(input.message);
  const body = [
    `[Compazio request ${input.requestId} from ${source}]`,
    message,
    "",
    "When the work is complete, return the complete result as one quoted argument with:",
    `compazio reply ${input.requestId} "<result>"`,
    "Use reply exactly once for this request. Do not send a new request back unless explicitly asked."
  ].join("\n");
  if (Buffer.byteLength(body, "utf8") > maximumEnvelopeBytes) {
    throw new ConnectionBrokerError(
      "MESSAGE_TOO_LARGE",
      "A mensagem e seu envelope excedem 32 KB."
    );
  }
  return {
    pasteFrame: `\u001b[200~${body}\u001b[201~`,
    submit: "\r"
  };
}

function normalizeMessage(value: string): string {
  const normalized = sanitizeTerminalText(value).trim();
  if (normalized === "") {
    throw new ConnectionBrokerError("MESSAGE_EMPTY", "A mensagem não pode estar vazia.");
  }
  if (Buffer.byteLength(normalized, "utf8") > maximumMessageBytes) {
    throw new ConnectionBrokerError("MESSAGE_TOO_LARGE", "A mensagem excede 32 KB.");
  }
  return normalized;
}

function normalizeResponse(value: string): string {
  const normalized = sanitizeTerminalText(value).trim();
  if (normalized === "") {
    throw new ConnectionBrokerError("RESPONSE_EMPTY", "A resposta não pode estar vazia.");
  }
  if (normalized.length > 64_000) {
    throw new ConnectionBrokerError("RESPONSE_TOO_LARGE", "A resposta excede 64 KB.");
  }
  return normalized;
}

function sanitizeTerminalText(value: string): string {
  return [...value.replace(/\r\n?/g, "\n")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code === 9 || code === 10 || (code >= 32 && code !== 127 && !(code >= 128 && code <= 159))
      );
    })
    .join("");
}
