import { readFileSync } from "node:fs";

const LOCAL_SYSTEM_VERSIONS_FILE = new URL("../../lib/system-versions.json", import.meta.url);

export function positiveInteger(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loadSystemVersions() {
  const candidates = [process.env.SDA_SYSTEM_VERSIONS_FILE, LOCAL_SYSTEM_VERSIONS_FILE].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const source = readFileSync(candidate, "utf8");

      return JSON.parse(source);
    } catch {
      // Deployment can run with explicit env overrides before the JSON is copied.
    }
  }

  return {};
}

const SYSTEM_COMPONENT_VERSIONS = loadSystemVersions();

function componentVersion(envName, component) {
  return process.env[envName] ?? SYSTEM_COMPONENT_VERSIONS[component] ?? "0.0.0";
}

export const PORT = Number(process.env.PORT ?? 8787);
export const DATA_DIR =
  process.env.SDA_COMPUTE_GATEWAY_DATA_DIR ?? "/var/lib/sda-compute-gateway";
export const COMPUTE_GATEWAY_VERSION = componentVersion(
  "SDA_COMPUTE_GATEWAY_VERSION",
  "compute_gateway_extraction"
);
export const EXTRACTION_PIPELINE_VERSION = componentVersion(
  "SDA_EXTRACTION_PIPELINE_VERSION",
  "extraction_pipeline"
);
export const INDEXING_PIPELINE_VERSION = componentVersion(
  "SDA_INDEXING_PIPELINE_VERSION",
  "indexing_pipeline"
);
export const INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY;
export const MAX_CONCURRENT_JOBS = positiveInteger(process.env.SDA_COMPUTE_GATEWAY_CONCURRENCY, 1);
export const MAX_REQUEST_BODY_BYTES = positiveInteger(
  process.env.SDA_COMPUTE_GATEWAY_MAX_BODY_BYTES,
  1_048_576
);
export const MINERU_BACKEND = process.env.SDA_MINERU_BACKEND ?? "pipeline";
export const MINERU_BIN =
  process.env.SDA_MINERU_BIN ?? "/home/sistemas/sda-mineru/.venv/bin/mineru";
export const MINERU_LANG = process.env.SDA_MINERU_LANG ?? "latin";
export const MINERU_PDF_RENDER_TIMEOUT = process.env.SDA_MINERU_PDF_RENDER_TIMEOUT ?? "600";
export const MINERU_TASK_RESULT_TIMEOUT = process.env.SDA_MINERU_TASK_RESULT_TIMEOUT ?? "1800";
export const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
export const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
export const TOKEN = process.env.SDA_COMPUTE_GATEWAY_TOKEN;
export const TREE_INDEXER_TOKEN = process.env.SDA_TREE_INDEXER_TOKEN ?? TOKEN;
export const TREE_INDEXER_URL = (process.env.SDA_TREE_INDEXER_URL ?? "http://127.0.0.1:8790").replace(
  /\/+$/,
  ""
);
