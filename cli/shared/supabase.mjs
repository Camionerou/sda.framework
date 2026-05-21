import { createClient } from "@supabase/supabase-js";

import { loadSdaEnv, requiredEnv } from "./env.mjs";

export function createAdminClient() {
  loadSdaEnv();

  return createClient(
    requiredEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
}

export async function resolveTenantId(supabase, input = {}) {
  if (input.tenantId) {
    return input.tenantId;
  }

  const envTenantId = process.env.TENANT_ID?.trim();

  if (envTenantId) {
    return envTenantId;
  }

  const slug = input.tenantSlug ?? process.env.TENANT_SLUG?.trim() ?? "sda-framework";
  const { data, error } = await supabase
    .from("tenants")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data?.id) {
    throw new Error(`No encontre tenant con slug ${slug}.`);
  }

  return data.id;
}
