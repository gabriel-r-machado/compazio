import {
  correlationId,
  guard,
  hmacCode,
  json,
  publicError,
  rateLimit,
  readJson,
  signEntitlement,
  supabase,
  strictBody,
  verifyEntitlement
} from "../_shared/license.ts";

Deno.serve(async (request) => {
  const id = correlationId(request);
  const methodError = guard(request, "POST", id);
  if (methodError !== null) return methodError;
  const body = await readJson(request);
  if (!strictBody(body, ["entitlement", "installationId", "appVersion"]))
    return publicError("LICENSE_INVALID", id);
  const entitlement =
    typeof body?.entitlement === "string" && body.entitlement.length < 8192
      ? body.entitlement
      : null;
  const installationId =
    typeof body?.installationId === "string" && /^[0-9a-f-]{36}$/i.test(body.installationId)
      ? body.installationId
      : null;
  const appVersion = typeof body?.appVersion === "string" ? body.appVersion.slice(0, 80) : null;
  if (entitlement === null || installationId === null || appVersion === null)
    return publicError("LICENSE_INVALID", id);
  const signedEntitlement = await verifyEntitlement(entitlement, installationId);
  if (signedEntitlement === null) return publicError("LICENSE_INVALID", id);
  const installationHash = await hmacCode(installationId);
  if (!rateLimit(installationHash, 24, 86_400_000))
    return publicError("LICENSE_RATE_LIMITED", id, 429);
  try {
    const { data: activation } = await supabase
      .from("license_activations")
      .select("id,license_id,status")
      .eq("installation_hash", installationHash)
      .eq("status", "active")
      .maybeSingle();
    if (activation === null) return publicError("LICENSE_INVALID", id);
    if (signedEntitlement.activationId !== activation.id) return publicError("LICENSE_INVALID", id);
    const { data: license } = await supabase
      .from("app_licenses")
      .select("plan,max_workspaces,expires_at,version,status")
      .eq("id", activation.license_id)
      .maybeSingle();
    if (license === null || license.status !== "active") return publicError("LICENSE_INACTIVE", id);
    if (license.expires_at !== null && new Date(license.expires_at).getTime() <= Date.now())
      return publicError("LICENSE_EXPIRED", id);
    await supabase
      .from("license_activations")
      .update({ last_refreshed_at: new Date().toISOString(), app_version: appVersion })
      .eq("id", activation.id);
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const signed = await signEntitlement({
      schemaVersion: 1,
      keyId: Deno.env.get("LICENSE_SIGNING_KEY_ID") ?? "beta",
      plan: license.plan,
      installationId,
      maxWorkspaces: license.max_workspaces ?? null,
      issuedAt,
      expiresAt,
      activationId: activation.id,
      licenseVersion: license.version
    });
    return json({ ok: true, entitlement: signed }, 200, id);
  } catch {
    return publicError("LICENSE_SERVER_UNAVAILABLE", id, 503);
  }
});
