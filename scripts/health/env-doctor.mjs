import { loadEnvFiles } from "../shared/env-loader.mjs";

loadEnvFiles([".env.local", ".env"], { override: false });

const json = process.argv.includes("--json");
const strict = process.argv.includes("--strict") || process.env.CI === "true";
const checks = [];

function value(name) {
  const raw = process.env[name];

  return typeof raw === "string" && raw.trim() ? raw.trim() : "";
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
