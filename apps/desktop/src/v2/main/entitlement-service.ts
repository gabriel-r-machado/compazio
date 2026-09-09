import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import { mkdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const FREE_WORKSPACE_LIMIT_ERROR = "FREE_WORKSPACE_LIMIT_REACHED" as const;

/** Dedicated opt-in. It controls nothing else, so no other debugging switch can lift the gate. */
export const TEST_UNLIMITED_FLAG = "COMPAZIO_TEST_UNLIMITED_WORKSPACES" as const;
/** Identifies the harness run. Must match the marker the harness wrote inside its own data root. */
export const TEST_HARNESS_ID_VARIABLE = "COMPAZIO_TEST_HARNESS_ID" as const;
export const TEST_HARNESS_MARKER_FILE = ".compazio-test-harness" as const;

export type EntitlementPlan = "free" | "beta_unlimited";

export interface EntitlementPayload {
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly plan: "beta_unlimited";
  readonly installationId: string;
  readonly maxWorkspaces: number | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly activationId: string;
  readonly licenseVersion: number;
}

export interface EntitlementStatus {
  readonly plan: EntitlementPlan;
  readonly valid: boolean;
  readonly maxWorkspaces: number | null;
  readonly installationId: string;
  readonly lastValidatedAt: string | null;
  readonly nextValidationAt: string | null;
  readonly expiresAt: string | null;
  readonly reason?: "none" | "expired" | "invalid-signature" | "wrong-installation" | "offline";
}

export interface EntitlementStorage {
  readonly encrypt?: (value: string) => string;
  readonly decrypt?: (value: string) => string;
}

export interface EntitlementServiceOptions {
  readonly statePath: string;
  readonly publicKeyPem?: string;
  readonly supabaseUrl?: string;
  readonly supabasePublishableKey?: string;
  readonly appVersion: string;
  readonly platform?: string;
  readonly architecture?: string;
  readonly now?: () => Date;
  readonly fetch?: typeof globalThis.fetch;
  readonly storage?: EntitlementStorage;
  /** Only the explicit Electron smoke may use a loopback HTTP fixture. Production remains HTTPS-only. */
  readonly allowInsecureLocalTestEndpoint?: boolean;
}

interface LocalLicenseState {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly entitlement?: string;
  readonly lastValidatedAt?: string;
  readonly lastError?: string;
}

export class EntitlementError extends Error {
  public constructor(
    public readonly code: typeof FREE_WORKSPACE_LIMIT_ERROR | "LICENSE_INVALID" | "LICENSE_OFFLINE",
    message: string
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

/**
 * Not exported. Only {@link EntitlementService.forIsolatedTest}, in this module, can produce it, so
 * no caller elsewhere can construct a service that skips the gate — not even by passing the flag.
 */
const ISOLATED_TEST_TOKEN = Symbol("compazio.isolated-test-entitlement");

/**
 * Main-process source of truth for the beta entitlement. It deliberately has no renderer or
 * Supabase client dependency: only this service can read/write the local entitlement and apply the
 * free workspace gate.
 */
export class EntitlementService {
  private readonly now: () => Date;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly statePath: string;
  private state: LocalLicenseState | null = null;
  /**
   * True only for a service built by {@link EntitlementService.forIsolatedTest} after it proved the
   * state lives under the OS temporary root. No option and no environment variable reaches it.
   */
  private readonly testUnlimited: boolean;

  public constructor(
    private readonly options: EntitlementServiceOptions,
    token?: symbol
  ) {
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.statePath = options.statePath;
    this.testUnlimited = token === ISOLATED_TEST_TOKEN;
  }

  /**
   * The single way to lift the free workspace limit without a signed entitlement. It refuses any
   * state path outside the OS temporary root, so an isolated harness can never raise the limit on a
   * real installation even if it is started with the wrong environment.
   */
  public static forIsolatedTest(
    options: EntitlementServiceOptions & { readonly harnessId: string }
  ): EntitlementService {
    if (options.harnessId.trim() === "") {
      throw new EntitlementError("LICENSE_INVALID", "An isolated test run needs a harness id.");
    }
    if (!isPathInside(tmpdir(), options.statePath)) {
      throw new EntitlementError(
        "LICENSE_INVALID",
        "An isolated test entitlement requires state under the OS temporary root."
      );
    }
    return new EntitlementService(options, ISOLATED_TEST_TOKEN);
  }

  public async installationId(): Promise<string> {
    return (await this.load()).installationId;
  }

  public async status(): Promise<EntitlementStatus> {
    const state = await this.load();
    const now = this.now();
    if (state.entitlement === undefined) {
      return {
        plan: "free",
        valid: true,
        maxWorkspaces: 1,
        installationId: state.installationId,
        lastValidatedAt: state.lastValidatedAt ?? null,
        nextValidationAt: null,
        expiresAt: null,
        reason: "none"
      };
    }
    const payload = this.verifyEntitlement(state.entitlement, state.installationId);
    if (payload === null) {
      return {
        plan: "free",
        valid: false,
        maxWorkspaces: 1,
        installationId: state.installationId,
        lastValidatedAt: state.lastValidatedAt ?? null,
        nextValidationAt: null,
        expiresAt: null,
        reason: "invalid-signature"
      };
    }
    const expiry = new Date(payload.expiresAt).getTime();
    if (!Number.isFinite(expiry)) {
      return {
        plan: "free",
        valid: false,
        maxWorkspaces: 1,
        installationId: state.installationId,
        lastValidatedAt: state.lastValidatedAt ?? null,
        nextValidationAt: null,
        expiresAt: null,
        reason: "invalid-signature"
      };
    }
    const graceUntil = expiry + 7 * 24 * 60 * 60 * 1000;
    if (now.getTime() > graceUntil) {
      return {
        plan: "free",
        valid: false,
        maxWorkspaces: 1,
        installationId: state.installationId,
        lastValidatedAt: state.lastValidatedAt ?? null,
        nextValidationAt: null,
        expiresAt: payload.expiresAt,
        reason: "expired"
      };
    }
    return {
      plan: "beta_unlimited",
      valid: true,
      maxWorkspaces: null,
      installationId: state.installationId,
      lastValidatedAt: state.lastValidatedAt ?? null,
      nextValidationAt: new Date(
        Math.max(now.getTime(), new Date(payload.issuedAt).getTime()) + 24 * 60 * 60 * 1000
      ).toISOString(),
      expiresAt: payload.expiresAt,
      ...(now.getTime() > expiry ? { reason: "offline" as const } : {})
    };
  }

  public async assertCanCreateWorkspace(existingWorkspaceCount: number): Promise<void> {
    if (this.testUnlimited) return;
    const status = await this.status();
    if (status.maxWorkspaces !== null && existingWorkspaceCount >= status.maxWorkspaces) {
      throw new EntitlementError(
        FREE_WORKSPACE_LIMIT_ERROR,
        "O beta gratuito permite um workspace por instalação. Ative uma licença para criar workspaces ilimitados."
      );
    }
  }

  public async activate(licenseCode: string): Promise<EntitlementStatus> {
    const code = licenseCode.trim();
    if (!/^CMPZ-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){4,5}$/i.test(code)) {
      throw new EntitlementError("LICENSE_INVALID", "O código de licença não é válido.");
    }
    const url = this.functionUrl("license-activate");
    if (url === null)
      throw new EntitlementError("LICENSE_OFFLINE", "Não foi possível validar a licença agora.");
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.supabasePublishableKey === undefined
            ? {}
            : { apikey: this.options.supabasePublishableKey })
        },
        body: JSON.stringify({
          licenseCode: code,
          installationId: await this.installationId(),
          appVersion: this.options.appVersion,
          platform: this.options.platform ?? process.platform,
          architecture: this.options.architecture ?? process.arch
        })
      });
      if (!response.ok)
        throw new EntitlementError("LICENSE_INVALID", "O código de licença não foi aceito.");
      const body = (await response.json()) as { entitlement?: string };
      if (typeof body.entitlement !== "string")
        throw new EntitlementError(
          "LICENSE_INVALID",
          "O servidor não retornou uma licença válida."
        );
      const state = await this.load();
      if (this.verifyEntitlement(body.entitlement, state.installationId) === null)
        throw new EntitlementError(
          "LICENSE_INVALID",
          "A licença recebida não pôde ser verificada."
        );
      await this.save({
        ...state,
        entitlement: body.entitlement,
        lastValidatedAt: this.now().toISOString()
      });
      return this.status();
    } catch (error) {
      if (error instanceof EntitlementError) throw error;
      throw new EntitlementError("LICENSE_OFFLINE", "Não foi possível validar a licença agora.");
    }
  }

  public async deactivate(): Promise<void> {
    const state = await this.load();
    const url = this.functionUrl("license-deactivate");
    if (url !== null && state.entitlement !== undefined) {
      try {
        await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.options.supabasePublishableKey === undefined
              ? {}
              : { apikey: this.options.supabasePublishableKey })
          },
          body: JSON.stringify({
            entitlement: state.entitlement,
            installationId: state.installationId,
            confirm: true
          })
        });
      } catch {
        // Local removal remains deterministic when the network is unavailable.
      }
    }
    await this.save({ schemaVersion: 1, installationId: state.installationId });
  }

  public async refresh(): Promise<EntitlementStatus> {
    const state = await this.load();
    if (state.entitlement === undefined) return this.status();
    const lastValidated =
      state.lastValidatedAt === undefined ? null : new Date(state.lastValidatedAt);
    if (lastValidated !== null && Number.isFinite(lastValidated.getTime())) {
      const elapsed = this.now().getTime() - lastValidated.getTime();
      if (elapsed >= 0 && elapsed < 24 * 60 * 60 * 1000) return this.status();
    }
    const url = this.functionUrl("license-refresh");
    if (url === null) return this.status();
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.supabasePublishableKey === undefined
            ? {}
            : { apikey: this.options.supabasePublishableKey })
        },
        body: JSON.stringify({
          entitlement: state.entitlement,
          installationId: state.installationId,
          appVersion: this.options.appVersion
        })
      });
      if (!response.ok) {
        let code: unknown = undefined;
        try {
          code = (await response.json()) as { error?: { code?: unknown } };
          code = (code as { error?: { code?: unknown } }).error?.code;
        } catch {
          // A non-JSON server response is treated as a temporary outage.
        }
        if (["LICENSE_INVALID", "LICENSE_INACTIVE", "LICENSE_EXPIRED"].includes(String(code))) {
          await this.save({ schemaVersion: 1, installationId: state.installationId });
        }
        return this.status();
      }
      const body = (await response.json()) as { entitlement?: string };
      if (typeof body.entitlement !== "string") return this.status();
      if (this.verifyEntitlement(body.entitlement, state.installationId) === null)
        return this.status();
      await this.save({
        ...state,
        entitlement: body.entitlement,
        lastValidatedAt: this.now().toISOString()
      });
    } catch {
      // A temporary network error never revokes a still-valid local entitlement.
    }
    return this.status();
  }

  private async load(): Promise<LocalLicenseState> {
    if (this.state !== null) return this.state;
    try {
      const parsed = JSON.parse(
        await readFile(this.statePath, "utf8")
      ) as Partial<LocalLicenseState>;
      if (parsed.schemaVersion !== 1 || typeof parsed.installationId !== "string")
        throw new Error("invalid");
      const state: LocalLicenseState = {
        schemaVersion: 1,
        installationId: parsed.installationId,
        ...(typeof parsed.entitlement === "string"
          ? { entitlement: this.decodeStored(parsed.entitlement) }
          : {}),
        ...(typeof parsed.lastValidatedAt === "string"
          ? { lastValidatedAt: parsed.lastValidatedAt }
          : {})
      };
      this.state = state;
      return state;
    } catch {
      const state: LocalLicenseState = { schemaVersion: 1, installationId: randomUUID() };
      await this.save(state);
      return state;
    }
  }

  private async save(state: LocalLicenseState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const encoded: LocalLicenseState = {
      ...state,
      ...(state.entitlement === undefined
        ? {}
        : { entitlement: this.encodeStored(state.entitlement) })
    };
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(encoded, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
    await rm(this.statePath, { force: true });
    await rename(temporaryPath, this.statePath);
    this.state = { ...state };
  }

  private encodeStored(value: string): string {
    const encrypted = this.options.storage?.encrypt?.(value);
    return encrypted === undefined
      ? `plain:${Buffer.from(value, "utf8").toString("base64url")}`
      : `safe:${encrypted}`;
  }

  private decodeStored(value: string): string {
    if (value.startsWith("safe:")) return this.options.storage?.decrypt?.(value.slice(5)) ?? "";
    if (value.startsWith("plain:"))
      return Buffer.from(value.slice(6), "base64url").toString("utf8");
    return value;
  }

  private verifyEntitlement(serialized: string, installationId: string): EntitlementPayload | null {
    const [encodedPayload, encodedSignature] = serialized.split(".");
    if (
      encodedPayload === undefined ||
      encodedSignature === undefined ||
      this.options.publicKeyPem === undefined
    )
      return null;
    try {
      const payload = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf8")
      ) as EntitlementPayload;
      if (
        payload.schemaVersion !== 1 ||
        payload.installationId !== installationId ||
        payload.plan !== "beta_unlimited" ||
        typeof payload.keyId !== "string" ||
        typeof payload.activationId !== "string" ||
        typeof payload.licenseVersion !== "number" ||
        typeof payload.issuedAt !== "string" ||
        typeof payload.expiresAt !== "string" ||
        (payload.maxWorkspaces !== null && typeof payload.maxWorkspaces !== "number")
      )
        return null;
      const publicKey = createPublicKey(this.options.publicKeyPem);
      const valid = verifySignature(
        null,
        Buffer.from(encodedPayload),
        publicKey,
        Buffer.from(encodedSignature, "base64url")
      );
      return valid ? payload : null;
    } catch {
      return null;
    }
  }

  private functionUrl(name: string): string | null {
    const base = this.options.supabaseUrl?.replace(/\/$/, "");
    const secure = base !== undefined && /^https:\/\//i.test(base);
    const isolatedLoopback =
      this.options.allowInsecureLocalTestEndpoint === true &&
      base !== undefined &&
      /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(base);
    return secure || isolatedLoopback ? `${base}/functions/v1/${name}` : null;
  }

  public static installationFingerprint(installationId: string): string {
    return createHash("sha256").update(installationId).digest("hex");
  }
}

export interface TestHarnessProbe {
  readonly environment: NodeJS.ProcessEnv;
  /** The V2 storage root this process will actually write to. */
  readonly stateDirectory: string;
  readonly packaged: boolean;
  readonly temporaryRoot?: string;
  readonly readMarker?: (path: string) => Promise<string>;
}

/**
 * Resolves the harness id for a run that may lift the free workspace limit. Every condition must
 * hold at the same time: a development binary, a test environment, the dedicated opt-in, a state
 * root under the OS temporary directory, and a marker file the harness itself wrote there. A normal
 * `pnpm dev`, an installed build, a manually unpacked build, the renderer, and any agent started
 * outside the harness all fail at least one condition, so none of them can raise the limit.
 */
export async function resolveTestHarnessId(probe: TestHarnessProbe): Promise<string | null> {
  if (probe.packaged) return null;
  if (probe.environment.NODE_ENV !== "test") return null;
  if (probe.environment[TEST_UNLIMITED_FLAG] !== "1") return null;
  const harnessId = probe.environment[TEST_HARNESS_ID_VARIABLE]?.trim() ?? "";
  if (harnessId === "") return null;
  if (!isPathInside(probe.temporaryRoot ?? tmpdir(), probe.stateDirectory)) return null;
  const read = probe.readMarker ?? ((path: string) => readFile(path, "utf8"));
  try {
    const marker = await read(resolve(probe.stateDirectory, TEST_HARNESS_MARKER_FILE));
    return marker.trim() === harnessId ? harnessId : null;
  } catch {
    return null;
  }
}

/** Writes the marker that pairs a temporary state root with the harness run that owns it. */
export async function writeTestHarnessMarker(
  stateDirectory: string,
  harnessId: string
): Promise<void> {
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(resolve(stateDirectory, TEST_HARNESS_MARKER_FILE), harnessId, "utf8");
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}
