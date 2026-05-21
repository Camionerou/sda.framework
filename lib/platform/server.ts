import { SYSTEM_COMPONENT_VERSIONS } from "@/lib/system-versions";
import {
  envValue,
  optionalOriginEnv,
  optionalUrlEnv
} from "@/lib/platform/env";

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
  const value = Number(envValue(name));

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function getVercelRuntime() {
  return {
    env: envValue("VERCEL_ENV") || envValue("NODE_ENV") || "local",
    gitCommitSha: envValue("VERCEL_GIT_COMMIT_SHA") || envValue("GITHUB_SHA") || null,
    projectProductionUrl: envValue("VERCEL_PROJECT_PRODUCTION_URL") || null
  };
}

export function defaultUpstashRedisKeyPrefix() {
  return `sda:${cleanProviderKeyPart(getVercelRuntime().env)}`;
}

function safeOptionalOriginEnv(name: string) {
  try {
    return optionalOriginEnv(name);
  } catch {
    return "";
  }
}

function safeOptionalUrlEnv(name: string) {
  try {
    return optionalUrlEnv(name);
  } catch {
    return "";
  }
}

export function resolveAppOrigin(requestOrigin?: string | null) {
  const vercel = getVercelRuntime();

  if (requestOrigin) {
    return new URL(requestOrigin).origin;
  }

  const appOrigin = safeOptionalOriginEnv("APP_ORIGIN") || safeOptionalOriginEnv("NEXT_PUBLIC_APP_URL");

  if (appOrigin) {
    return appOrigin;
  }

  if (vercel.projectProductionUrl) {
    const productionOrigin = safeOptionalOriginEnv("VERCEL_PROJECT_PRODUCTION_URL");

    if (productionOrigin) {
      return productionOrigin;
    }
  }

  return "http://localhost:3000";
}

export function getSupabaseAdminConfig(): SupabaseAdminConfig {
  const url = optionalUrlEnv("SUPABASE_URL") || optionalUrlEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey =
    envValue("SUPABASE_SERVICE_ROLE_KEY") || envValue("SUPABASE_SECRET_KEY");

  if (!url || !serviceRoleKey) {
    throw new Error("Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.");
  }

  return { serviceRoleKey, url };
}

export function getUpstashRedisConfig(): UpstashRedisConfig | null {
  const url = safeOptionalUrlEnv("UPSTASH_REDIS_REST_URL");
  const token = envValue("UPSTASH_REDIS_REST_TOKEN");

  if (!url || !token) {
    return null;
  }

  return {
    keyPrefix:
      envValue("UPSTASH_REDIS_KEY_PREFIX") ||
      defaultUpstashRedisKeyPrefix(),
    token,
    url
  };
}

export function getInngestRuntimeConfig(): InngestRuntimeConfig {
  return {
    appVersion:
      envValue("INNGEST_APP_VERSION") ||
      getVercelRuntime().gitCommitSha ||
      SYSTEM_COMPONENT_VERSIONS.app,
    canDispatchEvents: envValue("INNGEST_DEV") === "1" || Boolean(envValue("INNGEST_EVENT_KEY")),
    id: envValue("INNGEST_APP_ID") || "sda-framework",
    isDev:
      envValue("INNGEST_DEV") === "1" ||
      (envValue("NODE_ENV") !== "production" && !envValue("INNGEST_SIGNING_KEY"))
  };
}
