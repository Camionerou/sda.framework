import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

import { loadEnvFiles } from "../shared/env-loader.mjs";

loadEnvFiles([".env.local", ".env"], { override: false });

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const noCache = argv.includes("--no-cache");
const refreshCache = argv.includes("--refresh-cache");
const requireFreshIndexes =
  argv.includes("--require-fresh-indexes") ||
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

function normalizeSnapshotRpcResponse(data) {
  if (Array.isArray(data)) {
    return data[0] ?? null;
  }
  return data ?? null;
}

async function readHealthSnapshot() {
  if (noCache) {
    return {
      fallback_reason: "disabled",
      refresh_requested: refreshCache,
      used: false
    };
  }

  if (refreshCache) {
    const { data, error } = await supabase.rpc("refresh_indexing_health_snapshot");
    const row = normalizeSnapshotRpcResponse(data);

    if (!error && row?.data) {
      return {
        data: row.data,
        fallback_reason: null,
        refreshed_at: row.refreshed_at ?? null,
        refresh_requested: true,
        used: true
      };
    }

    return {
      error: error?.message ?? "refresh_indexing_health_snapshot no devolvio datos",
      fallback_reason: "refresh_failed",
      refresh_requested: true,
      used: false
    };
  }

  const { data, error } = await supabase
    .from("indexing_health_snapshot")
    .select("refreshed_at,data")
    .limit(1)
    .maybeSingle();

  if (error || !data?.data) {
    return {
      error: error?.message ?? "indexing_health_snapshot no tiene filas",
      fallback_reason: error ? "read_failed" : "empty",
      refresh_requested: false,
      used: false
    };
  }

  return {
    data: data.data,
    fallback_reason: null,
    refreshed_at: data.refreshed_at ?? null,
    refresh_requested: false,
    used: true
  };
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

const snapshot = await readHealthSnapshot();
const liveAnomaliesQuery = snapshot.used
  ? Promise.resolve({ data: snapshot.data.anomalies ?? [], error: null })
  : supabase
      .from("indexing_health_anomalies")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1000);
const liveCountQueries = snapshot.used
  ? Promise.resolve({
      chunks: snapshot.data.counts?.chunks ?? null,
      doc_tree: snapshot.data.counts?.doc_tree ?? null,
      doc_tree_nodes: snapshot.data.counts?.doc_tree_nodes ?? null,
      documents: snapshot.data.counts?.documents ?? null,
      indexing_events: snapshot.data.counts?.indexing_events ?? null,
      indexing_runs: snapshot.data.counts?.indexing_runs ?? null
    })
  : Promise.all([
      countRows("documents", "id"),
      countRows("indexing_runs", "id"),
      countRows("indexing_events", "id"),
      countRows("doc_tree", "document_id"),
      countRows("doc_tree_nodes", "id"),
      countRows("chunks", "id")
    ]).then(([documents, indexingRuns, indexingEvents, docTree, docTreeNodes, chunks]) => ({
      chunks,
      doc_tree: docTree,
      doc_tree_nodes: docTreeNodes,
      documents,
      indexing_events: indexingEvents,
      indexing_runs: indexingRuns
    }));

const [anomaliesResult, documentsResult, counts] = await Promise.all([
  liveAnomaliesQuery,
  supabase
    .from("documents")
    .select(
      "id,tenant_id,filename,status,indexed_at,indexing_pipeline_version,extraction_pipeline_version,tree_indexer_version,embedding_pipeline_version"
    )
    .eq("status", "indexed")
    .limit(1000),
  liveCountQueries
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
  cache: {
    fallback_reason: snapshot.fallback_reason,
    refresh_requested: snapshot.refresh_requested,
    refreshed_at: snapshot.refreshed_at ?? null,
    snapshot_error: snapshot.error ?? null,
    source: snapshot.used ? "indexing_health_snapshot" : "live",
    used: snapshot.used
  },
  env: {
    admin_public_url_mismatch: Boolean(adminUrl && publicUrl && adminUrl !== publicUrl),
    supabase_host: new URL(url).host
  },
  counts,
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
