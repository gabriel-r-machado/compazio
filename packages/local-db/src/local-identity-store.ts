import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import Database from "better-sqlite3";

export type LocalIdentityKind = "user" | "agent" | "cli" | "orchestrator" | "runtime";

export interface LocalIdentity {
  readonly id: string;
  readonly kind: LocalIdentityKind;
  readonly subjectId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface CreateLocalIdentityInput {
  readonly kind: LocalIdentityKind;
  readonly subjectId: string;
  readonly label: string;
}

export interface LocalAuthCredential {
  readonly identityId: string;
  readonly token: string;
  readonly nonce: string;
  readonly expiresAt: string;
}

export interface AuthenticateLocalIdentityInput {
  readonly identityId: string;
  readonly token: string;
  readonly nonce: string;
}

interface IdentityRow {
  readonly id: string;
  readonly kind: string;
  readonly subject_id: string;
  readonly label: string;
  readonly created_at: number;
  readonly revoked_at: number | null;
}

interface SessionRow {
  readonly identity_id: string;
  readonly token_hash: string;
  readonly nonce_hash: string;
  readonly expires_at: number;
  readonly revoked_at: number | null;
}

export class SqliteLocalIdentityStore {
  private readonly sqlite: Database.Database;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly secret: () => string;

  public constructor(
    filename: string,
    options: {
      readonly now?: () => Date;
      readonly id?: () => string;
      readonly secret?: () => string;
    } = {}
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.secret = options.secret ?? (() => randomBytes(32).toString("base64url"));
  }

  public ensureIdentity(input: CreateLocalIdentityInput): LocalIdentity {
    validateIdentityInput(input);
    return this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare(
          `SELECT id, kind, subject_id, label, created_at, revoked_at
           FROM local_identities WHERE kind = ? AND subject_id = ?`
        )
        .get(input.kind, input.subjectId) as IdentityRow | undefined;
      if (existing !== undefined) return toIdentity(existing);
      const timestamp = this.now().getTime();
      const identity: IdentityRow = {
        id: this.id(),
        kind: input.kind,
        subject_id: input.subjectId,
        label: input.label,
        created_at: timestamp,
        revoked_at: null
      };
      this.sqlite
        .prepare(
          `INSERT INTO local_identities (id, kind, subject_id, label, created_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)`
        )
        .run(identity.id, identity.kind, identity.subject_id, identity.label, identity.created_at);
      this.recordEvent(
        identity.id,
        null,
        "identity_created",
        "local_identity_registered",
        timestamp
      );
      return toIdentity(identity);
    })();
  }

  public issueSession(identityId: string, ttlMs = 12 * 60 * 60 * 1000): LocalAuthCredential {
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 7 * 24 * 60 * 60 * 1000) {
      throw new Error("Local authentication session lifetime is invalid");
    }
    return this.sqlite.transaction(() => {
      this.requireIdentity(identityId);
      const timestamp = this.now().getTime();
      this.sqlite
        .prepare(
          `UPDATE local_auth_sessions SET revoked_at = ?
           WHERE identity_id = ? AND revoked_at IS NULL`
        )
        .run(timestamp, identityId);
      const token = this.secret();
      const nonce = this.secret();
      const expiresAt = timestamp + ttlMs;
      this.sqlite
        .prepare(
          `INSERT INTO local_auth_sessions
           (id, identity_id, token_hash, nonce_hash, issued_at, expires_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(this.id(), identityId, hashSecret(token), hashSecret(nonce), timestamp, expiresAt);
      this.recordEvent(
        identityId,
        identityId,
        "session_rotated",
        "local_session_issued",
        timestamp
      );
      return { identityId, token, nonce, expiresAt: new Date(expiresAt).toISOString() };
    })();
  }

  public authenticate(input: AuthenticateLocalIdentityInput): LocalIdentity | null {
    if (
      !isBoundedSecret(input.identityId, 160) ||
      !isBoundedSecret(input.token, 256) ||
      !isBoundedSecret(input.nonce, 256)
    ) {
      return null;
    }
    return this.sqlite.transaction(() => {
      const session = this.sqlite
        .prepare(
          `SELECT identity_id, token_hash, nonce_hash, expires_at, revoked_at
           FROM local_auth_sessions WHERE identity_id = ? AND revoked_at IS NULL
           ORDER BY issued_at DESC LIMIT 1`
        )
        .get(input.identityId) as SessionRow | undefined;
      const timestamp = this.now().getTime();
      if (
        session === undefined ||
        session.expires_at <= timestamp ||
        !secretsMatch(input.token, session.token_hash) ||
        !secretsMatch(input.nonce, session.nonce_hash)
      ) {
        this.recordEvent(
          null,
          null,
          "authentication_rejected",
          "invalid_local_credential",
          timestamp
        );
        return null;
      }
      const identity = this.requireIdentity(input.identityId);
      if (identity.revokedAt !== null) {
        this.recordEvent(
          identity.id,
          identity.id,
          "authentication_rejected",
          "identity_revoked",
          timestamp
        );
        return null;
      }
      this.recordEvent(
        identity.id,
        identity.id,
        "authentication_accepted",
        "local_credential_verified",
        timestamp
      );
      return identity;
    })();
  }

  public close(): void {
    this.sqlite.close();
  }

  private requireIdentity(identityId: string): LocalIdentity {
    const row = this.sqlite
      .prepare(
        `SELECT id, kind, subject_id, label, created_at, revoked_at
         FROM local_identities WHERE id = ?`
      )
      .get(identityId) as IdentityRow | undefined;
    if (row === undefined) throw new Error("Local identity was not found");
    return toIdentity(row);
  }

  private recordEvent(
    identityId: string | null,
    actorIdentityId: string | null,
    type: string,
    reason: string,
    createdAt: number
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO local_identity_events
         (id, identity_id, actor_identity_id, type, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(this.id(), identityId, actorIdentityId, type, reason, createdAt);
  }
}

function validateIdentityInput(input: CreateLocalIdentityInput): void {
  if (!(["user", "agent", "cli", "orchestrator", "runtime"] as const).includes(input.kind)) {
    throw new Error("Local identity kind is invalid");
  }
  if (!isBoundedSecret(input.subjectId, 160) || !isBoundedSecret(input.label, 160)) {
    throw new Error("Local identity is invalid");
  }
}

function toIdentity(row: IdentityRow): LocalIdentity {
  if (
    !(["user", "agent", "cli", "orchestrator", "runtime"] as const).includes(
      row.kind as LocalIdentityKind
    )
  ) {
    throw new Error("Stored local identity kind is invalid");
  }
  return {
    id: row.id,
    kind: row.kind as LocalIdentityKind,
    subjectId: row.subject_id,
    label: row.label,
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString()
  };
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secretsMatch(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isBoundedSecret(value: string, maximumLength: number): boolean {
  return value.length > 0 && value.length <= maximumLength;
}
