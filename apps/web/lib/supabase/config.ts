export interface SupabasePublicConfiguration {
  readonly url: string;
  readonly publishableKey: string;
}

export interface SupabaseServerConfiguration extends SupabasePublicConfiguration {
  readonly serviceRoleKey: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function getSupabasePublicConfiguration(
  environment: Environment = process.env
): SupabasePublicConfiguration | null {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = (
    environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? environment.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();

  if (
    url === undefined ||
    url.length === 0 ||
    publishableKey === undefined ||
    publishableKey.length === 0
  ) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.protocol !== "https:" &&
      parsedUrl.hostname !== "127.0.0.1" &&
      parsedUrl.hostname !== "localhost"
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return { url, publishableKey };
}

export function getSupabaseServerConfiguration(
  environment: Environment = process.env
): SupabaseServerConfiguration | null {
  const publicConfiguration = getSupabasePublicConfiguration(environment);
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (publicConfiguration === null || serviceRoleKey === undefined || serviceRoleKey.length === 0) {
    return null;
  }

  return { ...publicConfiguration, serviceRoleKey };
}
