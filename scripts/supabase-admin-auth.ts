export function resolveSupabaseAdminKey(environment: NodeJS.ProcessEnv = process.env): string {
  const secretKey = environment.SUPABASE_SECRET_KEY?.trim();
  if (secretKey) return secretKey;

  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (serviceRoleKey) return serviceRoleKey;

  throw new Error("SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required locally.");
}

export function supabaseAdminHeaders(
  key: string,
  contentType = "application/json"
): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: key,
    "content-type": contentType
  };

  // New Supabase secret keys are API keys, not JWT bearer credentials.
  if (!key.startsWith("sb_secret_")) headers.authorization = `Bearer ${key}`;

  return headers;
}
