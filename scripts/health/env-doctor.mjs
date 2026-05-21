import { cleanEnvValue, loadEnvFiles } from "../shared/env-loader.mjs";

loadEnvFiles([".env.local", ".env"], { override: false });

const json = process.argv.includes("--json");
const strict = process.argv.includes("--strict") || process.env.CI === "true";
const checks = [];

function value(name) {
  return cleanEnvValue(process.env[name]);
}

function rawValue(name) {
  return process.env[name];
}

function hasSuspiciousOuterQuotes(name) {
  const raw = rawValue(name);

  if (typeof raw !== "string") {
    return false;
  }

  const trimmed = raw.trim();

  return (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  );
}

function add(status, id, message, metadata = {}) {
  checks.push({ id, message, metadata, status });
}

function host(name) {
  const raw = value(name);

  if (!raw) {
    return null;
  }

  try {
    return new URL(raw).host;
  } catch {
    add("error", `${name.toLowerCase()}.url`, `${name} no es una URL valida.`);
    return null;
  }
}

function origin(name) {
  const raw = value(name);

  if (!raw) {
    return null;
  }

  const normalized = raw.startsWith("http://") || raw.startsWith("https://")
    ? raw
    : `https://${raw}`;

  try {
    return new URL(normalized).origin;
  } catch {
    add("error", `${name.toLowerCase()}.url`, `${name} no es una URL/origin valido.`);
    return null;
  }
}

function expectedInngestAppUrl(appOrigin) {
  return appOrigin ? `${appOrigin}/api/inngest` : null;
}

for (const key of [
  "APP_ORIGIN",
  "NEXT_PUBLIC_APP_URL",
  "INNGEST_APP_URL",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_KEY_PREFIX"
]) {
  if (hasSuspiciousOuterQuotes(key)) {
    add(
      strict ? "error" : "warning",
      `${key.toLowerCase()}.quoted`,
      `${key} parece incluir comillas como parte del valor. Guardar el valor sin comillas en Vercel/env.`
    );
  }
}

const publicSupabaseHost = host("NEXT_PUBLIC_SUPABASE_URL");
const adminSupabaseHost = host("SUPABASE_URL");

if (publicSupabaseHost && adminSupabaseHost) {
  if (publicSupabaseHost === adminSupabaseHost) {
    add("ok", "supabase.url_match", "Supabase admin/public URL usan el mismo host.", {
      host: publicSupabaseHost
    });
  } else {
    add(
      strict ? "error" : "warning",
      "supabase.url_mismatch",
      `SUPABASE_URL (${adminSupabaseHost}) y NEXT_PUBLIC_SUPABASE_URL (${publicSupabaseHost}) apuntan a hosts distintos.`
    );
  }
} else {
  add("info", "supabase.url_pair", "Supabase URL admin/public incompletas en este entorno.");
}

const publicKeys = ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const serviceKeys = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"];

for (const publicKey of publicKeys) {
  for (const serviceKey of serviceKeys) {
    if (value(publicKey) && value(serviceKey) && value(publicKey) === value(serviceKey)) {
      add("error", "supabase.public_service_key_reuse", `${publicKey} no debe ser igual a ${serviceKey}.`);
    }
  }
}

if (!checks.some((check) => check.id === "supabase.public_service_key_reuse")) {
  add("ok", "supabase.key_separation", "Supabase public/service keys no estan reutilizadas.");
}

const appOrigin = origin("APP_ORIGIN") || origin("NEXT_PUBLIC_APP_URL");
const vercelProductionOrigin = origin("VERCEL_PROJECT_PRODUCTION_URL");
const canonicalOrigin = appOrigin || vercelProductionOrigin;
const inngestAppUrl = value("INNGEST_APP_URL");

if (canonicalOrigin) {
  add("ok", "app.canonical_origin", `Origen canonico detectado: ${canonicalOrigin}.`);
} else {
  add(
    value("VERCEL_ENV") === "production" ? "warning" : "info",
    "app.canonical_origin",
    "APP_ORIGIN o NEXT_PUBLIC_APP_URL no estan configurados; se usara el host de request/Vercel."
  );
}

if (inngestAppUrl && canonicalOrigin) {
  const expected = expectedInngestAppUrl(canonicalOrigin);
  if (inngestAppUrl === expected) {
    add("ok", "inngest.app_url", "INNGEST_APP_URL usa el origen canonico.");
  } else {
    add(
      strict ? "error" : "warning",
      "inngest.app_url",
      `INNGEST_APP_URL deberia ser ${expected} para el origen canonico actual.`
    );
  }
} else if (value("INNGEST_EVENT_KEY") || value("INNGEST_SIGNING_KEY")) {
  add(
    strict ? "error" : "warning",
    "inngest.app_url",
    "INNGEST_APP_URL falta aunque Inngest esta configurado."
  );
}

if (value("UPSTASH_REDIS_REST_URL")) {
  host("UPSTASH_REDIS_REST_URL");
}

if (value("VERCEL_ENV") === "production" && value("UPSTASH_REDIS_KEY_PREFIX") === "sda:local") {
  add("error", "redis.production_prefix", "UPSTASH_REDIS_KEY_PREFIX no debe ser sda:local en production.");
} else {
  add("ok", "redis.production_prefix", "Redis no usa prefijo local en production.");
}

const summary = {
  errors: checks.filter((check) => check.status === "error").length,
  info: checks.filter((check) => check.status === "info").length,
  ok: checks.filter((check) => check.status === "ok").length,
  warnings: checks.filter((check) => check.status === "warning").length
};

if (json) {
  console.log(JSON.stringify({ checks, summary }, null, 2));
} else {
  console.log("Env doctor");

  for (const check of checks) {
    const prefix = check.status === "warning" ? "warn" : check.status;
    console.log(`${prefix.padEnd(5)} ${check.id}: ${check.message}`);
  }

  console.log(
    `Summary: ${summary.ok} ok, ${summary.info} info, ${summary.warnings} warnings, ${summary.errors} errors.`
  );
}

if (summary.errors > 0) {
  process.exit(1);
}
