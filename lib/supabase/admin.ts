import { createClient } from "@supabase/supabase-js";

import { getSupabaseAdminConfig } from "@/lib/platform/server";

export function createAdminClient() {
  const { serviceRoleKey, url } = getSupabaseAdminConfig();

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}
