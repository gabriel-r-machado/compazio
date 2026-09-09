import { correlationId, guard, json, publicError, supabase } from "../_shared/license.ts";

Deno.serve(async (request) => {
  const id = correlationId(request);
  const methodError = guard(request, "GET", id);
  if (methodError !== null) return methodError;
  try {
    const { data, error } = await supabase
      .from("app_releases")
      .select(
        "channel,version,platform,architecture,installer_path,update_metadata_path,sha256,size_bytes,signed,release_notes_path,published_at"
      )
      .eq("channel", "beta")
      .eq("platform", "windows")
      .eq("architecture", "x64")
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || data === null) return publicError("RELEASE_NOT_AVAILABLE", id, 404);
    const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
    const url = (path: string | null) => {
      if (path === null) return null;
      try {
        const external = new URL(path);
        if (external.protocol === "https:" && external.hostname === "github.com")
          return external.toString();
      } catch {
        // Legacy paths remain available only for already-recorded Storage releases.
      }
      return `${base}/storage/v1/object/public/compazio-releases/${path}`;
    };
    return json(
      {
        ok: true,
        channel: data.channel,
        version: data.version,
        platform: data.platform,
        architecture: data.architecture,
        downloadUrl: url(data.installer_path),
        metadataUrl: url(data.update_metadata_path),
        sha256: data.sha256,
        sizeBytes: data.size_bytes,
        signed: data.signed,
        releaseNotesUrl: url(data.release_notes_path),
        publishedAt: data.published_at
      },
      200,
      id
    );
  } catch {
    return publicError("RELEASE_NOT_AVAILABLE", id, 503);
  }
});
