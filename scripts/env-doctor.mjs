import { loadEnvFiles } from "./env-loader.mjs";

loadEnvFiles();

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const json = args.has("--json");

const checks = [];

function value(name) {
  const raw = process.env[name];

  return typeof raw === "string" && raw.trim() ? raw.trim() : "";
}

function has(name) {
  return Boolean(value(name));
}

function add(status, id, message, metadata = {}) {
  checks.push({ id, message, metadata, status });
}

function ok(id, message, metadata) {
  add("ok", id, message, metadata);
}

function warn(id, message, metadata) {
  add("warning", id, message, metadata);
}

function error(id, message, metadata) {
  add("error", id, message, metadata);
}

function validUrl(raw, protocols = ["https:", "http:"]) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);

    return protocols.includes(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

function hostFor(name) {
  const parsed = validUrl(value(name));

  return parsed?.host;
}

function requireInStrict(name, id, description) {
  if (has(name)) {
    ok(id, `${description} configurado.`);
    return;
  }

  if (strict) {
    error(id, `${description} falta en modo strict.`);
  } else {
    warn(id, `${description} no esta configurado.`);
  }
}

function checkUrl(name, id, description, { required = false, publicHttps = false } = {}) {
  const raw = value(name);

  if (!raw) {
    if (required) {
      requireInStrict(name, id, description);
    }
    return;
  }

  const parsed = validUrl(raw);

  if (!parsed) {
    error(id, `${description} no es una URL valida.`);
    return;
  }

  if (publicHttps && parsed.protocol !== "https:") {
    error(id, `${description} debe ser HTTPS publico.`);
    return;
  }

  ok(id, `${description} apunta a ${parsed.host}.`);
}

function checkPair(left, right, id, description) {
  const leftSet = has(left);
  const rightSet = has(right);

  if (leftSet && rightSet) {
    ok(id, `${description} configurado.`);
    return;
  }

  if (!leftSet && !rightSet) {
    warn(id, `${description} no esta configurado.`);
    return;
  }

  error(id, `${description} esta incompleto: configurar ${left} y ${right}.`);
}

checkUrl("NEXT_PUBLIC_SUPABASE_URL", "supabase.public_url", "NEXT_PUBLIC_SUPABASE_URL", {
  required: true
});

if (has("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") || has("NEXT_PUBLIC_SUPABASE_ANON_KEY")) {
  ok("supabase.public_key", "Supabase public key configurada.");
} else {
  requireInStrict("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "supabase.public_key", "Supabase public key");
}

checkUrl("SUPABASE_URL", "supabase.admin_url", "SUPABASE_URL");

if (has("SUPABASE_SERVICE_ROLE_KEY") || has("SUPABASE_SECRET_KEY")) {
  ok("supabase.service_key", "Supabase service key configurada para scripts backend.");
} else {
  requireInStrict("SUPABASE_SERVICE_ROLE_KEY", "supabase.service_key", "Supabase service key");
}

if (has("SUPABASE_URL") && has("NEXT_PUBLIC_SUPABASE_URL")) {
  const adminHost = hostFor("SUPABASE_URL");
  const publicHost = hostFor("NEXT_PUBLIC_SUPABASE_URL");

  if (adminHost && publicHost && adminHost !== publicHost) {
    const message = `SUPABASE_URL (${adminHost}) y NEXT_PUBLIC_SUPABASE_URL (${publicHost}) apuntan a hosts distintos.`;

    if (strict) {
      error("supabase.url_mismatch", message);
    } else {
      warn("supabase.url_mismatch", message);
    }
  } else if (adminHost && publicHost) {
    ok("supabase.url_match", "Supabase admin/public URL usan el mismo host.", { host: publicHost });
  }
}

const publicKeys = ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const serviceKeys = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"];

for (const publicKey of publicKeys) {
  for (const serviceKey of serviceKeys) {
    if (has(publicKey) && has(serviceKey) && value(publicKey) === value(serviceKey)) {
      error("supabase.public_service_key_reuse", `${publicKey} no debe ser igual a ${serviceKey}.`);
    }
  }
}

if (value("INNGEST_DEV") === "1") {
  ok("inngest.dev", "INNGEST_DEV=1 habilita modo local.");
} else if (has("INNGEST_EVENT_KEY")) {
  ok("inngest.event_key", "INNGEST_EVENT_KEY configurado.");
} else {
  warn("inngest.event_key", "INNGEST_EVENT_KEY no esta configurado; no se podran despachar eventos cloud.");
}

checkUrl("INNGEST_APP_URL", "inngest.app_url", "INNGEST_APP_URL", { publicHttps: true });

if (has("INNGEST_API_KEY")) {
  ok("inngest.api_key", "INNGEST_API_KEY configurado para sync.");
} else {
  warn("inngest.api_key", "INNGEST_API_KEY no esta configurado; `npm run inngest:sync` no va a correr.");
}

if (has("INNGEST_SIGNING_KEY")) {
  ok("inngest.signing_key", "INNGEST_SIGNING_KEY configurado.");
} else {
  warn("inngest.signing_key", "INNGEST_SIGNING_KEY no esta configurado; validar antes de produccion.");
}

checkPair("COMPUTE_GATEWAY_URL", "COMPUTE_GATEWAY_TOKEN", "compute.gateway_pair", "Compute Gateway");
checkUrl("COMPUTE_GATEWAY_URL", "compute.gateway_url", "COMPUTE_GATEWAY_URL");

checkPair("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "redis.rest_pair", "Upstash Redis REST");
checkUrl("UPSTASH_REDIS_REST_URL", "redis.rest_url", "UPSTASH_REDIS_REST_URL", {
  publicHttps: true
});

if (has("UPSTASH_REDIS_REST_URL") && !has("UPSTASH_REDIS_KEY_PREFIX")) {
  warn("redis.key_prefix", "UPSTASH_REDIS_KEY_PREFIX no esta configurado; se usara el default por ambiente.");
}

if (value("VERCEL_ENV") === "production" && value("UPSTASH_REDIS_KEY_PREFIX") === "sda:local") {
  error("redis.production_prefix", "UPSTASH_REDIS_KEY_PREFIX no debe ser sda:local en production.");
}

if (has("SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID") || has("SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET")) {
  checkPair(
    "SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID",
    "SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET",
    "oauth.google_pair",
    "Google OAuth"
  );
} else {
  warn("oauth.google_pair", "Google OAuth no esta configurado en este entorno.");
}

checkUrl("APP_ORIGIN", "app.origin", "APP_ORIGIN");

const summary = {
  errors: checks.filter((check) => check.status === "error").length,
  ok: checks.filter((check) => check.status === "ok").length,
  strict,
  warnings: checks.filter((check) => check.status === "warning").length
};

if (json) {
  console.log(JSON.stringify({ checks, summary }, null, 2));
} else {
  console.log(`Env doctor (${strict ? "strict" : "default"})`);

  for (const check of checks) {
    const prefix = check.status === "ok" ? "ok" : check.status === "warning" ? "warn" : "error";
    console.log(`${prefix.padEnd(5)} ${check.id}: ${check.message}`);
  }

  console.log(
    `Summary: ${summary.ok} ok, ${summary.warnings} warnings, ${summary.errors} errors.`
  );
}

if (summary.errors > 0) {
  process.exit(1);
}
