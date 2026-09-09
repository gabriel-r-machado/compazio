import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteLocalIdentityStore } from "./local-identity-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteLocalIdentityStore", () => {
  it("rotates hashed local credentials and records authenticated decisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-identity-"));
    directories.push(directory);
    const filename = join(directory, "runtime.db");
    runLocalMigrations({ filename });
    let identifier = 0;
    let secret = 0;
    const store = new SqliteLocalIdentityStore(filename, {
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      id: () => `identity-event-${++identifier}`,
      secret: () => `credential-${++secret}`
    });
    try {
      const identity = store.ensureIdentity({
        kind: "cli",
        subjectId: "compasso-cli",
        label: "Compasso CLI"
      });
      const agentIdentity = store.ensureIdentity({
        kind: "agent",
        subjectId: "workspace:workspace-1:agent:agent-1",
        label: "Canvas agent agent-1"
      });
      expect(agentIdentity.kind).toBe("agent");
      expect(
        store.ensureIdentity({
          kind: "cli",
          subjectId: "compasso-cli",
          label: "Ignored duplicate label"
        })
      ).toEqual(identity);

      const first = store.issueSession(identity.id);
      expect(
        store.authenticate({ identityId: identity.id, token: first.token, nonce: first.nonce })
      ).toEqual(identity);
      expect(
        store.authenticate({
          identityId: "unknown-identity",
          token: first.token,
          nonce: first.nonce
        })
      ).toBeNull();

      const second = store.issueSession(identity.id);
      expect(
        store.authenticate({ identityId: identity.id, token: first.token, nonce: first.nonce })
      ).toBeNull();
      expect(
        store.authenticate({ identityId: identity.id, token: second.token, nonce: second.nonce })
      ).toEqual(identity);

      const sqlite = new Database(filename, { readonly: true });
      try {
        const storedSessions = sqlite
          .prepare("SELECT token_hash, nonce_hash FROM local_auth_sessions ORDER BY issued_at, id")
          .all() as readonly { readonly token_hash: string; readonly nonce_hash: string }[];
        expect(storedSessions).toHaveLength(2);
        expect(JSON.stringify(storedSessions)).not.toContain(first.token);
        expect(JSON.stringify(storedSessions)).not.toContain(first.nonce);
        const events = sqlite
          .prepare("SELECT type FROM local_identity_events")
          .all()
          .map((row) => (row as { readonly type: string }).type);
        expect(events).toHaveLength(8);
        expect(events.filter((type) => type === "identity_created")).toHaveLength(2);
        expect(events.filter((type) => type === "session_rotated")).toHaveLength(2);
        expect(events.filter((type) => type === "authentication_accepted")).toHaveLength(2);
        expect(events.filter((type) => type === "authentication_rejected")).toHaveLength(2);
      } finally {
        sqlite.close();
      }
    } finally {
      store.close();
    }
  });
});
