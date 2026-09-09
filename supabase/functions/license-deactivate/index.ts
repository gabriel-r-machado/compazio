import {
  correlationId,
  guard,
  hmacCode,
  json,
  publicError,
  readJson,
  supabase,
  strictBody,
  verifyEntitlement
} from "../_shared/license.ts";

Deno.serve(async (request) => {
  const id = correlationId(request);
  const methodError = guard(request, "POST", id);
  if (methodError !== null) return methodError;
  const body = await readJson(request);
  if (!strictBody(body, ["entitlement", "installationId", "confirm"]))
    return publicError("LICENSE_INVALID", id);
  const installationId =
    typeof body?.installationId === "string" && /^[0-9a-f-]{36}$/i.test(body.installationId)
      ? body.installationId
      : null;
  if (installationId === null || body?.confirm !== true || typeof body?.entitlement !== "string")
    return publicError("LICENSE_INVALID", id);
  const signed = await verifyEntitlement(body.entitlement, installationId);
  if (signed === null) return publicError("LICENSE_INVALID", id);
  try {
    const installationHash = await hmacCode(installationId);
    const { data: activation } = await supabase
      .from("license_activations")
      .select("id,license_id")
      .eq("installation_hash", installationHash)
      .eq("status", "active")
      .maybeSingle();
    if (activation === null || signed.activationId !== activation.id)
      return publicError("LICENSE_INVALID", id);
    await supabase
      .from("license_activations")
      .update({ status: "deactivated", deactivated_at: new Date().toISOString() })
      .eq("id", activation.id);
    await supabase.from("license_events").insert({
      license_id: activation.license_id,
      activation_id: activation.id,
      event_type: "license.deactivate",
      outcome: "accepted",
      installation_hash: installationHash,
      correlation_id: id
    });
    return json({ ok: true, deactivated: true }, 200, id);
  } catch {
    return publicError("LICENSE_SERVER_UNAVAILABLE", id, 503);
  }
});
