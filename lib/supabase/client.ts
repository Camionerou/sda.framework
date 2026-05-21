"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getSupabasePublicConfig } from "@/lib/supabase/env";
import type { Database } from "@/lib/supabase/types.gen";

export function createClient() {
  const { url, key } = getSupabasePublicConfig();

  return createBrowserClient<Database>(url, key);
}
