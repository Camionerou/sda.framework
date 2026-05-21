import { existsSync, readFileSync } from "node:fs";

import { cleanEnvValue, loadEnvFiles } from "../shared/env-loader.mjs";

loadEnvFiles([".env.local", ".env"], { override: false });

const apply = process.argv.includes("--apply");
const json = process.argv.includes("--json");
const checks = [];

function add(status, id, message, metadata = {}) {
  checks.push({ id, message, metadata, status });
}

function env(name) {
  return cleanEnvValue(process.env[name]);
}

function readProjectRef() {
  const explicit = env("SUPABASE_PROJECT_REF");

  if (explicit) {
    return explicit;
  }

  const path = "supabase/.temp/project-ref";

  if (!existsSync(path)) {
    return "";
  }

  return readFileSync(path, "utf8").trim();
}

function parseQuotedValues(input) {
  return [...input.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function readLocalAuthConfig() {
  const path = "supabase/config.toml";
  const text = readFileSync(path, "utf8");
  const authStart = text.indexOf("[auth]");
  const nextSection = text.indexOf("\n[", authStart + 1);
  const authBlock = text.slice(authStart, nextSection === -1 ? undefined : nextSection);
  const siteUrl = authBlock.match(/^\s*site_url\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? "";
  const redirectsMatch = authBlock.match(/additional_redirect_urls\s*=\s*\[([\s\S]*?)\]/);
  const redirectUrls = redirectsMatch ? parseQuotedValues(redirectsMatch[1]) : [];

  return { redirectUrls, siteUrl };
}

async function fetchAuthConfig(projectRef, accessToken) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));

  return { body, response };
}

async function patchAuthConfig(projectRef, accessToken, desired) {
  const current = await fetchAuthConfig(projectRef, accessToken);

  if (!current.response.ok) {
    return current;
  }

  const existingRedirects = String(current.body.uri_allow_list ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const uriAllowList = [...new Set([...existingRedirects, ...desired.redirectUrls])].join(",");

  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
    body: JSON.stringify({
      site_url: desired.siteUrl,
      uri_allow_list: uriAllowList
    }),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    method: "PATCH"
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));

  return { body, response };
}

const projectRef = readProjectRef();
const accessToken = env("SUPABASE_ACCESS_TOKEN");
const desired = readLocalAuthConfig();

if (!projectRef) {
  add("error", "supabase_auth.project_ref", "Falta SUPABASE_PROJECT_REF o supabase/.temp/project-ref.");
}

if (!accessToken) {
  add("error", "supabase_auth.access_token", "Falta SUPABASE_ACCESS_TOKEN para leer Management API.");
}

if (!desired.siteUrl) {
  add("error", "supabase_auth.local_site_url", "supabase/config.toml no define auth.site_url.");
}

if (desired.redirectUrls.length === 0) {
  add("error", "supabase_auth.local_redirects", "supabase/config.toml no define auth.additional_redirect_urls.");
}

let remote = null;

if (checks.every((check) => check.status !== "error")) {
  if (apply) {
    const patched = await patchAuthConfig(projectRef, accessToken, desired);

    if (patched.response.ok) {
      add("ok", "supabase_auth.apply", "Supabase Auth remoto actualizado desde config.toml.");
    } else {
      add("error", "supabase_auth.apply", `Management API PATCH fallo con status ${patched.response.status}.`, {
        body: patched.body
      });
    }
  }

  const fetched = await fetchAuthConfig(projectRef, accessToken);

  if (fetched.response.ok) {
    remote = fetched.body;
    add("ok", "supabase_auth.fetch", "Supabase Auth remoto leido por Management API.");
  } else {
    add("error", "supabase_auth.fetch", `Management API GET fallo con status ${fetched.response.status}.`, {
      body: fetched.body
    });
  }
}

if (remote) {
  const remoteRedirects = String(remote.uri_allow_list ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (remote.site_url === desired.siteUrl) {
    add("ok", "supabase_auth.site_url", `site_url remoto coincide con ${desired.siteUrl}.`);
  } else {
    add("error", "supabase_auth.site_url", `site_url remoto es ${remote.site_url}, esperado ${desired.siteUrl}.`);
  }

  const missingRedirects = desired.redirectUrls.filter((url) => !remoteRedirects.includes(url));

  if (missingRedirects.length === 0) {
    add("ok", "supabase_auth.redirects", "Todos los redirect URLs locales existen en Supabase Auth remoto.");
  } else {
    add("error", "supabase_auth.redirects", "Faltan redirect URLs remotos.", { missingRedirects });
  }

  if (remote.external_google_enabled) {
    add("ok", "supabase_auth.google_enabled", "Google OAuth esta habilitado.");
  } else {
    add("warning", "supabase_auth.google_enabled", "Google OAuth no esta habilitado.");
  }

  if (remote.external_google_client_id && remote.external_google_secret) {
    add("ok", "supabase_auth.google_credentials", "Google OAuth tiene client_id y secret configurados.");
  } else {
    add("warning", "supabase_auth.google_credentials", "Google OAuth no tiene client_id o secret completo.");
  }
}

const summary = {
  errors: checks.filter((check) => check.status === "error").length,
  info: checks.filter((check) => check.status === "info").length,
  ok: checks.filter((check) => check.status === "ok").length,
  warnings: checks.filter((check) => check.status === "warning").length
};

if (json) {
  console.log(JSON.stringify({ checks, projectRef, summary }, null, 2));
} else {
  console.log("Supabase Auth health");

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
