import { createClient } from "@supabase/supabase-js";

import { getSupabaseAdminConfig } from "@/lib/platform/server";
import type { Database } from "@/lib/supabase/types.gen";

export function createAdminClient() {
  const { serviceRoleKey, url } = getSupabaseAdminConfig();

  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}
