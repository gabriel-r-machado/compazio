import {
  correlationId,
  guard,
  hmacCode,
  json,
  normalizeCode,
  publicError,
  rateLimit,
  readJson,
  signEntitlement,
  supabase,
  strictBody
} from "../_shared/license.ts";

Deno.serve(async (request) => {
  const id = correlationId(request);
  const methodError = guard(request, "POST", id);
  if (methodError !== null) return methodError;
  const body = await readJson(request);
  if (
    !strictBody(body, ["licenseCode", "installationId", "appVersion", "platform", "architecture"])
  )
    return publicError("LICENSE_INVALID", id);
  const code = normalizeCode(body?.licenseCode);
  const installationId =
    typeof body?.installationId === "string" && /^[0-9a-f-]{36}$/i.test(body.installationId)
      ? body.installationId
      : null;
  const appVersion = typeof body?.appVersion === "string" ? body.appVersion.slice(0, 80) : null;
  if (code === null || installationId === null || appVersion === null)
    return publicError("LICENSE_INVALID", id);
  const installationHash = await hmacCode(installationId);
  if (!rateLimit(installationHash, 8)) return publicError("LICENSE_RATE_LIMITED", id, 429);
  try {
    const codeHash = await hmacCode(code);
    const { data, error } = await supabase.rpc("activate_beta_license", {
      p_code_hash: codeHash,
      p_installation_hash: installationHash,
      p_app_version: appVersion,
      p_correlation_id: id
    });
    if (error) return publicError("LICENSE_SERVER_UNAVAILABLE", id, 503);
    if (data === null) return publicError("LICENSE_INVALID", id);
    if (data.error === "inactive") return publicError("LICENSE_INACTIVE", id);
    if (data.error === "expired") return publicError("LICENSE_EXPIRED", id);
    if (data.error === "limit") return publicError("LICENSE_ACTIVATION_LIMIT", id, 409);
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const entitlement = await signEntitlement({
      schemaVersion: 1,
      keyId: Deno.env.get("LICENSE_SIGNING_KEY_ID") ?? "beta",
      plan: data.plan,
      installationId,
      maxWorkspaces: data.maxWorkspaces ?? null,
      issuedAt,
      expiresAt,
      activationId: data.activationId,
      licenseVersion: data.licenseVersion ?? 1
    });
    return json({ ok: true, entitlement }, 200, id);
  } catch {
    return publicError("LICENSE_SERVER_UNAVAILABLE", id, 503);
  }
});
