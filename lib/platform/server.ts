import { SYSTEM_COMPONENT_VERSIONS } from "@/lib/system-versions";

export type SupabaseAdminConfig = {
  serviceRoleKey: string;
  url: string;
};

export type UpstashRedisConfig = {
  keyPrefix: string;
  token: string;
  url: string;
};

export type InngestRuntimeConfig = {
  appVersion: string;
  canDispatchEvents: boolean;
  id: string;
  isDev: boolean;
};

export function cleanProviderKeyPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 180) || "unknown";
}

export function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function getVercelRuntime() {
  return {
    env: process.env.VERCEL_ENV || process.env.NODE_ENV || "local",
    gitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || null,
    projectProductionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL || null
  };
}

export function defaultUpstashRedisKeyPrefix() {
  return `sda:${cleanProviderKeyPart(getVercelRuntime().env)}`;
}

export function resolveAppOrigin(requestOrigin?: string | null) {
  const vercel = getVercelRuntime();

  if (requestOrigin) {
    return requestOrigin;
  }

  if (process.env.APP_ORIGIN) {
    return process.env.APP_ORIGIN;
  }

  if (vercel.projectProductionUrl) {
    return `https://${vercel.projectProductionUrl}`;
  }

  return "http://localhost:3000";
}

export function getSupabaseAdminConfig(): SupabaseAdminConfig {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.");
  }

  return { serviceRoleKey, url };
}

export function getUpstashRedisConfig(): UpstashRedisConfig | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (!url || !token) {
    return null;
  }

  return {
    keyPrefix:
      process.env.UPSTASH_REDIS_KEY_PREFIX?.trim() ||
      defaultUpstashRedisKeyPrefix(),
    token,
    url
  };
}

export function getInngestRuntimeConfig(): InngestRuntimeConfig {
  return {
    appVersion:
      process.env.INNGEST_APP_VERSION ??
      getVercelRuntime().gitCommitSha ??
      SYSTEM_COMPONENT_VERSIONS.app,
    canDispatchEvents: process.env.INNGEST_DEV === "1" || Boolean(process.env.INNGEST_EVENT_KEY),
    id: process.env.INNGEST_APP_ID?.trim() || "sda-framework",
    isDev:
      process.env.INNGEST_DEV === "1" ||
      (process.env.NODE_ENV !== "production" && !process.env.INNGEST_SIGNING_KEY)
  };
}
