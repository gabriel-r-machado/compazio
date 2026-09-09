"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabasePublicConfiguration } from "./config";

let browserClient: SupabaseClient | null | undefined;

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (browserClient !== undefined) {
    return browserClient;
  }

  const configuration = getSupabasePublicConfiguration();
  browserClient =
    configuration === null
      ? null
      : createBrowserClient(configuration.url, configuration.publishableKey);
  return browserClient;
}
