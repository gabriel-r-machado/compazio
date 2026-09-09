import { createHmac, randomInt } from "node:crypto";
import { resolveSupabaseAdminKey, supabaseAdminHeaders } from "../supabase-admin-auth";

const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const adminKey = resolveSupabaseAdminKey();
const pepper = process.env.LICENSE_CODE_PEPPER;
if (baseUrl === undefined || pepper === undefined) {
  throw new Error(
    "SUPABASE_URL, an administrative Supabase key and LICENSE_CODE_PEPPER are required locally."
  );
}
const licenseCodePepper: string = pepper;

const command = process.argv[2] ?? "help";
const headers = supabaseAdminHeaders(adminKey);
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function code(): string {
  const groups = Array.from({ length: 5 }, () =>
    Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("")
  );
  return `CMPZ-${groups.join("-")}`;
}

function hash(value: string): string {
  return createHmac("sha256", licenseCodePepper).update(value).digest("hex");
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
  return text === "" ? null : JSON.parse(text);
}

async function issue(): Promise<void> {
  const quantity = Math.max(
    1,
    Math.min(
      100,
      Number(process.argv.find((arg) => arg.startsWith("--quantity="))?.slice(11) ?? "1")
    )
  );
  const expires = process.argv.find((arg) => arg.startsWith("--expires-at="))?.slice(13);
  const isTest = process.argv.includes("--test");
  const output: string[] = [];
  for (let index = 0; index < quantity; index += 1) {
    const licenseCode = code();
    await request("/rest/v1/app_licenses", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        code_hash: hash(licenseCode),
        code_hint: licenseCode.slice(0, 9),
        plan: "beta_unlimited",
        status: "active",
        max_installations: 1,
        expires_at: expires ?? null,
        metadata: {
          issued_by: "local-admin",
          ...(isTest ? { test: true, purpose: "beta2-lifecycle" } : {})
        }
      })
    });
    output.push(licenseCode);
  }
  process.stdout.write(output.join("\n") + "\n");
}

async function list(): Promise<void> {
  const rows = await request(
    "/rest/v1/app_licenses?select=id,code_hint,plan,status,max_installations,expires_at,created_at&order=created_at.desc"
  );
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
}

async function mutate(status: "revoked" | "deactivated"): Promise<void> {
  const id = process.argv.find((arg) => arg.startsWith("--id="))?.slice(5);
  if (id === undefined) throw new Error("--id is required");
  if (status === "revoked" && process.argv.includes("--confirm") === false)
    throw new Error("Revocation requires --confirm");
  if (status === "revoked") {
    await request(`/rest/v1/app_licenses?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status, revoked_at: new Date().toISOString() })
    });
  } else {
    await request(`/rest/v1/license_activations?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "deactivated", deactivated_at: new Date().toISOString() })
    });
  }
}

async function main(): Promise<void> {
  if (command === "issue") await issue();
  else if (command === "list") await list();
  else if (command === "revoke") await mutate("revoked");
  else if (command === "deactivate") await mutate("deactivated");
  else throw new Error("Use issue, list, revoke or deactivate.");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "License administration failed.";
  console.error(message);
  process.exitCode = 1;
});
