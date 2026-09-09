import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export const MAX_BODY_BYTES = 16 * 1024;
export const ALLOWED_ORIGIN = Deno.env.get("LICENSE_ALLOWED_ORIGIN");

export const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const attempts = new Map<string, { count: number; resetAt: number }>();

export function correlationId(request: Request): string {
  const supplied = request.headers.get("x-correlation-id");
  return supplied !== null && /^[0-9a-f-]{36}$/i.test(supplied) ? supplied : crypto.randomUUID();
}

export function json(value: unknown, status = 200, correlation?: string): Response {
  return new Response(
    JSON.stringify({
      ...(typeof value === "object" && value !== null ? value : { data: value }),
      ...(correlation === undefined ? {} : { correlationId: correlation })
    }),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    }
  );
}

export function publicError(code: string, correlation: string, status = 400): Response {
  return json(
    { ok: false, error: { code, message: "Não foi possível processar a solicitação." } },
    status,
    correlation
  );
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return null;
  const bytes = new TextEncoder().encode(await request.text());
  if (bytes.byteLength > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function guard(request: Request, method: string, correlation: string): Response | null {
  if (request.method !== method) return publicError("METHOD_NOT_ALLOWED", correlation, 405);
  const origin = request.headers.get("origin");
  if (origin !== null && ALLOWED_ORIGIN !== undefined && origin !== ALLOWED_ORIGIN)
    return publicError("FORBIDDEN", correlation, 403);
  return null;
}

export function rateLimit(key: string, limit = 12, windowMs = 60_000): boolean {
  const now = Date.now();
  const previous = attempts.get(key);
  if (previous === undefined || previous.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (previous.count >= limit) return false;
  previous.count += 1;
  return true;
}

export function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase().replace(/\s+/g, "");
  return /^CMPZ-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){4,5}$/.test(code) ? code : null;
}

export function strictBody(
  body: Record<string, unknown> | null,
  allowed: readonly string[]
): boolean {
  if (body === null) return false;
  return Object.keys(body).every((key) => allowed.includes(key));
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export async function verifyEntitlement(
  serialized: unknown,
  installationId: string
): Promise<Record<string, unknown> | null> {
  if (typeof serialized !== "string" || serialized.length > 8192) return null;
  const [encodedPayload, encodedSignature] = serialized.split(".");
  const publicKey = Deno.env.get("LICENSE_SIGNING_PUBLIC_KEY");
  if (encodedPayload === undefined || encodedSignature === undefined || publicKey === undefined)
    return null;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      decodeBase64Url(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(encodedPayload)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload))) as Record<
      string,
      unknown
    >;
    return payload.schemaVersion === 1 &&
      payload.plan === "beta_unlimited" &&
      payload.installationId === installationId
      ? payload
      : null;
  } catch {
    return null;
  }
}

export async function hmacCode(code: string): Promise<string> {
  const pepper = Deno.env.get("LICENSE_CODE_PEPPER");
  if (pepper === undefined || pepper.length < 32) throw new Error("license secret unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(code));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signEntitlement(payload: Record<string, unknown>): Promise<string> {
  const rawKey = Deno.env.get("LICENSE_SIGNING_PRIVATE_KEY");
  if (rawKey === undefined) throw new Error("license signing key unavailable");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(rawKey), (char) => char.charCodeAt(0)),
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(encoded));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${encoded}.${encodedSignature}`;
}
