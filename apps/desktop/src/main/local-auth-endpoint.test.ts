import { afterEach, describe, expect, it } from "vitest";

import type { LocalIdentity } from "@forgedeck/local-db";

import { LocalAuthEndpoint } from "./local-auth-endpoint";

const endpoints: LocalAuthEndpoint[] = [];

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
});

describe("LocalAuthEndpoint", () => {
  it("binds to loopback and only reports health after authenticating a local credential", async () => {
    const identity: LocalIdentity = {
      id: "identity-cli",
      kind: "cli",
      subjectId: "compasso-cli",
      label: "Compasso CLI",
      createdAt: "2026-07-20T12:00:00.000Z",
      revokedAt: null
    };
    const endpoint = new LocalAuthEndpoint({
      authenticate: ({ identityId, token, nonce }) =>
        identityId === identity.id && token === "valid-token" && nonce === "valid-nonce"
          ? identity
          : null
    });
    endpoints.push(endpoint);
    const { url } = await endpoint.start();

    const rejected = await fetch(`${url}/v1/health`);
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({ error: "authentication_rejected" });

    const accepted = await fetch(`${url}/v1/health`, {
      headers: {
        authorization: "Bearer valid-token",
        "x-compasso-identity": identity.id,
        "x-compasso-nonce": "valid-nonce"
      }
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      status: "ready",
      identity: { id: identity.id, kind: "cli" }
    });
  });

  it("does not expose an arbitrary local endpoint surface", async () => {
    const endpoint = new LocalAuthEndpoint({ authenticate: () => null });
    endpoints.push(endpoint);
    const { url } = await endpoint.start();

    const response = await fetch(`${url}/v1/commands`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
