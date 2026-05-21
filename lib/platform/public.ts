import { cleanEnvValue } from "@/lib/platform/env";

export type SupabasePublicConfig = {
  key: string;
  url: string;
};

export function getSupabasePublicConfig(): SupabasePublicConfig {
  const rawUrl = cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const url = rawUrl ? new URL(rawUrl).origin : "";
  const key =
    cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) ||
    cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (!url || !key) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY o NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  return { key, url };
}
