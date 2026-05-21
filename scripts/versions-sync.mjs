import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

import { loadEnvFiles } from "./env-loader.mjs";

const VERSION_FILE = "lib/system-versions.ts";
const dryRun = process.argv.includes("--dry-run");

const DESCRIPTIONS = {
  app: "Next.js application shell, API routes, and CI scripts.",
  chat_agent: "End-user chat agent.",
  compute_gateway_extraction: "Compute Gateway worker and MinerU dispatch surface.",
  embedding_pipeline: "Hierarchical embedding pipeline.",
  extraction_pipeline: "MinerU extraction persistence pipeline.",
  indexing_pipeline: "End-to-end document indexing pipeline.",
  inngest_indexing_workflow: "Inngest orchestration for document indexing.",
  tree_indexer_python: "Python PageIndex-style Tree Indexer worker.",
  tree_indexer_typescript: "TypeScript PageIndex-style Tree Indexer.",
  tree_prompt: "Tree Indexer prompt contract."
};

function parseVersions(source) {
  const versions = {};
  const match = source.match(/SYSTEM_COMPONENT_VERSIONS\s*=\s*{([\s\S]*?)}\s*as const/);

  if (!match) {
    throw new Error(`No se encontro SYSTEM_COMPONENT_VERSIONS en ${VERSION_FILE}.`);
  }

  for (const item of match[1].matchAll(/([a-z][a-z0-9_]*):\s*"([^"]+)"/g)) {
    versions[item[1]] = item[2];
  }

  if (Object.keys(versions).length === 0) {
    throw new Error(`SYSTEM_COMPONENT_VERSIONS no contiene versiones parseables en ${VERSION_FILE}.`);
  }

  return versions;
}

function required(name, fallbackName) {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : undefined);

  if (!value) {
    const fallbackText = fallbackName ? ` o ${fallbackName}` : "";
    throw new Error(`Falta ${name}${fallbackText}.`);
  }

  return value;
}

function resolveSupabaseUrl() {
  const url =
    process.env.VERSION_SYNC_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;

  if (!url) {
    throw new Error("Falta VERSION_SYNC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_URL o SUPABASE_URL.");
  }

  return url;
}

const versions = parseVersions(readFileSync(VERSION_FILE, "utf8"));
const rows = Object.entries(versions).map(([component, version]) => ({
  component,
  description: DESCRIPTIONS[component] ?? `${component} component.`,
  metadata: {
    source: VERSION_FILE
  },
  version
}));

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dry_run: true,
        rows
      },
      null,
      2
    )
  );
  process.exit(0);
}

loadEnvFiles();

const url = resolveSupabaseUrl();
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY");
const supabase = createClient(url, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const { data, error } = await supabase
  .from("system_component_versions")
  .upsert(rows, { onConflict: "component" })
  .select("component,version,updated_at")
  .order("component");

if (error) {
  throw error;
}

console.log(
  JSON.stringify(
    {
      dry_run: false,
      supabase_host: new URL(url).host,
      synced: data ?? []
    },
    null,
    2
  )
);
