import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { getSupabasePublicConfiguration, getSupabaseServerConfiguration } from "./config";

export async function getSupabaseServerClient() {
  const configuration = getSupabasePublicConfiguration();
  if (configuration === null) {
    return null;
  }

  const cookieStore = await cookies();
  return createServerClient(configuration.url, configuration.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const cookie of cookiesToSet) {
            cookieStore.set(cookie.name, cookie.value, cookie.options);
          }
        } catch {
          // Server Components cannot mutate cookies. The callback route refreshes the session.
        }
      }
    }
  });
}

/**
 * Creates a server-side client scoped to one explicit user access token.
 *
 * This is intentionally separate from the service-role client: desktop sync
 * must remain subject to the same RLS policies as the signed-in user.
 */
export function getSupabaseAccessTokenClient(accessToken: string) {
  const configuration = getSupabasePublicConfiguration();
  if (configuration === null) {
    return null;
  }

  return createClient(configuration.url, configuration.publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });
}

export function getSupabaseAdminClient() {
  const configuration = getSupabaseServerConfiguration();
  if (configuration === null) {
    return null;
  }

  return createClient(configuration.url, configuration.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}
