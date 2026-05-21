import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

import { loadEnvFiles } from "../shared/env-loader.mjs";

loadEnvFiles([".env.local", ".env"], { override: false });

const strict = process.argv.includes("--strict");
const requireFreshIndexes =
  process.argv.includes("--require-fresh-indexes") ||
  process.env.INDEXING_HEALTH_REQUIRE_FRESH_INDEXES === "1";
const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const adminUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
const url = publicUrl ?? adminUrl;

if (!url || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});
const systemVersions = JSON.parse(
  readFileSync(new URL("../../lib/system-versions.json", import.meta.url), "utf8")
);

function shortId(value) {
  return value ? String(value).slice(0, 8) : null;
}

function ageHours(value) {
  if (!value) {
    return null;
  }

  return Math.round(((Date.now() - Date.parse(value)) / 3_600_000) * 10) / 10;
}

async function countRows(table, column) {
  const { count, error } = await supabase
    .from(table)
    .select(column, { count: "exact", head: true });

  return error ? { error: error.message } : count;
}

function versionDrift(document) {
  if (document.status !== "indexed") {
    return [];
  }

  const checks = [
    ["indexing_pipeline", document.indexing_pipeline_version],
    ["extraction_pipeline", document.extraction_pipeline_version],
    ["tree_indexer_python", document.tree_indexer_version],
    ["embedding_pipeline", document.embedding_pipeline_version]
  ];
  const reindexRequired = new Set([
    "extraction_pipeline",
    "indexing_pipeline",
    "tree_indexer_python"
  ]);

  return checks
    .map(([component, current]) => ({
      component,
      current: current ?? null,
      latest: systemVersions[component] ?? null,
      requires_reindex: reindexRequired.has(component)
    }))
    .filter((check) => check.current && check.latest && check.current !== check.latest);
}

const [
  anomaliesResult,
  documentsResult,
  documentCount,
  runCount,
  eventCount,
  treeCount,
  chunkCount
] = await Promise.all([
  supabase
    .from("indexing_health_anomalies")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1000),
  supabase
    .from("documents")
    .select(
      "id,tenant_id,filename,status,indexed_at,indexing_pipeline_version,extraction_pipeline_version,tree_indexer_version,embedding_pipeline_version"
    )
    .eq("status", "indexed")
    .limit(1000),
  countRows("documents", "id"),
  countRows("indexing_runs", "id"),
  countRows("indexing_events", "id"),
  countRows("doc_tree", "document_id"),
  countRows("chunks", "id")
]);

const anomalies = anomaliesResult.data ?? [];
const indexedDocuments = documentsResult.data ?? [];
const versionDriftDocuments = indexedDocuments.filter((document) => versionDrift(document).length > 0);
const reindexRequiredDocuments = versionDriftDocuments.filter((document) =>
  versionDrift(document).some((drift) => drift.requires_reindex)
);
const strictFailures = [
  requireFreshIndexes && reindexRequiredDocuments.length > 0 ? "stale_indexed_documents" : null
].filter(Boolean);

const output = {
  env: {
    admin_public_url_mismatch: Boolean(adminUrl && publicUrl && adminUrl !== publicUrl),
    supabase_host: new URL(url).host
  },
  counts: {
    chunks: chunkCount,
    doc_tree: treeCount,
    documents: documentCount,
    indexing_events: eventCount,
    indexing_runs: runCount
  },
  anomalies: anomalies.slice(0, 50).map((row) => ({
    anomaly: row.anomaly,
    doc: shortId(row.document_id),
    file: row.filename,
    message: row.message,
    run: shortId(row.run_id),
    stage: row.stage,
    status: row.document_status,
    updated_age_h: ageHours(row.updated_at)
  })),
  query_errors: Object.fromEntries(
    Object.entries({
      anomalies: anomaliesResult.error?.message,
      documents: documentsResult.error?.message
    }).filter(([, value]) => value)
  ),
  versions: {
    indexed_document_version_drift: versionDriftDocuments.slice(0, 10).map((document) => ({
      drift: versionDrift(document),
      file: document.filename,
      id: shortId(document.id),
      indexed_age_h: ageHours(document.indexed_at),
      status: document.status
    })),
    indexed_document_version_drift_count: versionDriftDocuments.length,
    indexed_document_reindex_required_count: reindexRequiredDocuments.length,
    latest: systemVersions
  },
  strict: {
    enabled: strict,
    failures: strictFailures,
    require_fresh_indexes: requireFreshIndexes
  }
};

console.log(JSON.stringify(output, null, 2));

if (
  anomalies.length > 0 ||
  Object.keys(output.query_errors).length > 0 ||
  (strict && strictFailures.length > 0)
) {
  process.exitCode = 1;
}
