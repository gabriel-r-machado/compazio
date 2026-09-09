import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { AuthenticateLocalIdentityInput, LocalIdentity } from "@forgedeck/local-db";

export interface LocalIdentityAuthenticator {
  authenticate(input: AuthenticateLocalIdentityInput): LocalIdentity | null;
}

export interface LocalAuthEndpointAddress {
  readonly url: string;
}

/**
 * A deliberately tiny loopback-only endpoint used by trusted local clients to prove their
 * short-lived runtime identity. It is not an Electron IPC surface and never accepts commands,
 * filesystem paths, SQL, or a renderer-origin request.
 */
export class LocalAuthEndpoint {
  private readonly server: Server;
  private address: LocalAuthEndpointAddress | null = null;

  public constructor(private readonly identities: LocalIdentityAuthenticator) {
    this.server = createServer((request, response) => this.handleRequest(request, response));
    this.server.headersTimeout = 5_000;
    this.server.requestTimeout = 5_000;
    this.server.keepAliveTimeout = 1_000;
    this.server.maxHeadersCount = 16;
  }

  public async start(): Promise<LocalAuthEndpointAddress> {
    if (this.address !== null) return this.address;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen({ host: "127.0.0.1", port: 0 });
    });
    const bound = this.server.address();
    if (bound === null || typeof bound === "string") {
      await this.close();
      throw new Error("Local authentication endpoint did not bind to TCP");
    }
    const port = (bound as AddressInfo).port;
    this.address = { url: `http://127.0.0.1:${port}` };
    return this.address;
  }

  public async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    this.address = null;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (!isLoopbackRequest(request) || request.method !== "GET" || request.url !== "/v1/health") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    const authorization = request.headers.authorization;
    const identityId = request.headers["x-compasso-identity"];
    const nonce = request.headers["x-compasso-nonce"];
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    if (
      typeof identityId !== "string" ||
      typeof nonce !== "string" ||
      token === null ||
      token.length === 0
    ) {
      writeJson(response, 401, { error: "authentication_rejected" });
      return;
    }
    const identity = this.identities.authenticate({ identityId, token, nonce });
    if (identity === null) {
      writeJson(response, 401, { error: "authentication_rejected" });
      return;
    }
    writeJson(response, 200, {
      status: "ready",
      identity: { id: identity.id, kind: identity.kind }
    });
  }
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  return request.socket.remoteAddress === "127.0.0.1";
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}
