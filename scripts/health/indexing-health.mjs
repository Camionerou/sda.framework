import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

import { cleanEnvValue, loadEnvFiles } from "../shared/env-loader.mjs";

loadEnvFiles([".env.local", ".env"], { override: false });

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const noCache = argv.includes("--no-cache");
const refreshCache = argv.includes("--refresh-cache");
const requireFreshIndexes =
  argv.includes("--require-fresh-indexes") ||
  process.env.INDEXING_HEALTH_REQUIRE_FRESH_INDEXES === "1";
const transientStaleHours = positiveNumber(
  process.env.INDEXING_HEALTH_TRANSIENT_STALE_HOURS,
  2
);
const publicUrl = cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_URL);
const adminUrl = cleanEnvValue(process.env.SUPABASE_URL);
const serviceRoleKey =
  cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY) ||
  cleanEnvValue(process.env.SUPABASE_SECRET_KEY);
const url = publicUrl || adminUrl;
const visibleDocumentStatuses = new Set([
  "uploaded",
  "queued",
  "parsing",
  "structuring",
  "embedding",
  "indexed"
]);

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

function positiveNumber(value, fallback) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function baseAnomaly(row) {
  return {
    anomaly: row.anomaly,
    doc: shortId(row.document_id),
    file: row.filename,
    message: row.message,
    run: shortId(row.run_id),
    stage: row.stage,
    status: row.document_status,
    updated_age_h: ageHours(row.updated_at)
  };
}

function classifyAnomaly(row) {
  const anomaly = baseAnomaly(row);

  switch (row.anomaly) {
    case "running_with_persisted_tree": {
      const stale = anomaly.updated_age_h !== null && anomaly.updated_age_h >= transientStaleHours;

      return {
        ...anomaly,
        category: "transient_reindex",
        health_state: stale ? "degraded" : "recovering",
        severity: stale ? "warning" : "info",
        state: stale ? "stale_reindex_overlap" : "reindexing_existing_index",
        transient: !stale
      };
    }
    case "uploaded_without_active_run":
      return {
        ...anomaly,
        category: "workflow",
        health_state: "degraded",
        severity: "warning",
        state: "awaiting_indexing_run",
        transient: false
      };
    case "nonterminal_without_active_run":
      return {
        ...anomaly,
        category: "workflow",
        health_state: "degraded",
        severity: "warning",
        state: "stalled_nonterminal_document",
        transient: false
      };
    case "active_run_without_uploaded_at":
      return {
        ...anomaly,
        category: "data_contract",
        health_state: "critical",
        severity: "critical",
        state: "active_run_missing_upload",
        transient: false
      };
    case "indexed_without_tree":
      return {
        ...anomaly,
        category: "index_integrity",
        health_state: "critical",
        severity: "critical",
        state: "indexed_document_missing_tree",
        transient: false
      };
    case "indexed_without_chunks":
      return {
        ...anomaly,
        category: "index_integrity",
        health_state: "critical",
        severity: "critical",
        state: "indexed_document_missing_chunks",
        transient: false
      };
    default:
      return {
        ...anomaly,
        category: "unknown",
        health_state: "degraded",
        severity: "warning",
        state: "unknown_anomaly",
        transient: false
      };
  }
}

function severityCounts(items) {
  return items.reduce(
    (counts, item) => {
      counts[item.severity] = (counts[item.severity] ?? 0) + 1;
      counts.total += 1;
      return counts;
    },
    { critical: 0, info: 0, total: 0, warning: 0 }
  );
}

function mergeSeverityCounts(...summaries) {
  return summaries.reduce(
    (merged, summary) => ({
      critical: merged.critical + (summary.critical ?? 0),
      info: merged.info + (summary.info ?? 0),
      total: merged.total + (summary.total ?? 0),
      warning: merged.warning + (summary.warning ?? 0)
    }),
    { critical: 0, info: 0, total: 0, warning: 0 }
  );
}

function classifyDocument(document) {
  const uploaded = Boolean(document.uploaded_at);
  const visible = uploaded && visibleDocumentStatuses.has(document.status);

  if (visible) {
    return null;
  }

  if (document.status === "failed" && uploaded) {
    return {
      category: "document_visibility",
      doc: shortId(document.id),
      file: document.filename,
      health_state: "degraded",
      hidden: true,
      message: "Documento cargado fallo indexacion y queda oculto",
      severity: "warning",
      state: "failed_loaded_hidden",
      status: document.status,
      updated_age_h: ageHours(document.updated_at)
    };
  }

  const unloaded = !uploaded;

  return {
    category: "document_visibility",
    doc: shortId(document.id),
    file: document.filename,
    health_state: "recovering",
    hidden: true,
    message: unloaded
      ? "Documento sin upload completo queda oculto"
      : "Documento no visible queda oculto",
    severity: "info",
    state: unloaded ? "not_loaded_hidden" : "hidden_by_status",
    status: document.status,
    updated_age_h: ageHours(document.updated_at)
  };
}

function documentSummary(documents, hiddenDocuments) {
  const byStatus = documents.reduce((counts, document) => {
    counts[document.status] = (counts[document.status] ?? 0) + 1;
    return counts;
  }, {});
  const hiddenByState = hiddenDocuments.reduce((counts, document) => {
    counts[document.state] = (counts[document.state] ?? 0) + 1;
    return counts;
  }, {});

  return {
    by_status: byStatus,
    hidden: hiddenDocuments.length,
    hidden_by_state: hiddenByState,
    total: documents.length,
    visible: documents.length - hiddenDocuments.length
  };
}

function latestRunsByDocument(runs) {
  const latest = new Map();

  for (const run of runs) {
    if (!latest.has(run.document_id)) {
      latest.set(run.document_id, run);
    }
  }

  return latest;
}

function classifyLatestRun(run, document) {
  if (!run || run.status !== "failed") {
    return null;
  }

  if (document?.status === "indexed") {
    return {
      category: "reindex",
      doc: shortId(run.document_id),
      file: document.filename,
      health_state: "degraded",
      message: "Ultima reindexacion fallo; indice anterior conservado",
      run: shortId(run.id),
      severity: "warning",
      stage: run.stage,
      state: "latest_reindex_failed_index_preserved",
      status: document.status,
      updated_age_h: ageHours(run.updated_at)
    };
  }

  return null;
}

function runSummary(runs) {
  const byStatus = runs.reduce((counts, run) => {
    counts[run.status] = (counts[run.status] ?? 0) + 1;
    return counts;
  }, {});
  const active = runs.filter((run) => run.status === "queued" || run.status === "running");

  return {
    active: active.length,
    active_samples: active.slice(0, 10).map((run) => ({
      doc: shortId(run.document_id),
      progress: run.progress,
      run: shortId(run.id),
      stage: run.stage,
      status: run.status,
      updated_age_h: ageHours(run.updated_at)
    })),
    by_status: byStatus,
    total: runs.length
  };
}

function healthState({ activeRunCount, findingSummary, queryErrors, strictFailures }) {
  if (queryErrors.length > 0 || findingSummary.critical > 0) {
    return "critical";
  }

  if (strict && strictFailures.length > 0) {
    return "critical";
  }

  if (findingSummary.warning > 0) {
    return "degraded";
  }

  if (findingSummary.info > 0 || activeRunCount > 0) {
    return "recovering";
  }

  return "healthy";
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
      "id,tenant_id,filename,status,uploaded_at,updated_at,indexed_at,indexing_pipeline_version,extraction_pipeline_version,tree_indexer_version,embedding_pipeline_version"
    )
    .limit(1000),
  liveCountQueries
]);

const anomalies = anomaliesResult.data ?? [];
const classifiedAnomalies = anomalies.map((row) => classifyAnomaly(row));
const anomalySummary = severityCounts(classifiedAnomalies);
const documents = documentsResult.data ?? [];
const hiddenDocuments = documents.map((document) => classifyDocument(document)).filter(Boolean);
const hiddenDocumentSummary = severityCounts(hiddenDocuments);
const indexedDocuments = documents.filter((document) => document.status === "indexed");
const versionDriftDocuments = indexedDocuments.filter((document) => versionDrift(document).length > 0);
const reindexRequiredDocuments = versionDriftDocuments.filter((document) =>
  versionDrift(document).some((drift) => drift.requires_reindex)
);
const runsResult = await supabase
  .from("indexing_runs")
  .select("id,document_id,status,stage,progress,updated_at,created_at")
  .order("created_at", { ascending: false })
  .limit(1000);
const runs = runsResult.data ?? [];
const runsSummary = runSummary(runs);
const documentsById = new Map(documents.map((document) => [document.id, document]));
const latestRunFindings = Array.from(latestRunsByDocument(runs).values())
  .map((run) => classifyLatestRun(run, documentsById.get(run.document_id)))
  .filter(Boolean);
const latestRunSummary = severityCounts(latestRunFindings);
const queryErrors = Object.fromEntries(
  Object.entries({
    anomalies: anomaliesResult.error?.message,
    documents: documentsResult.error?.message,
    runs: runsResult.error?.message
  }).filter(([, value]) => value)
);
const strictFailures = [
  requireFreshIndexes && reindexRequiredDocuments.length > 0 ? "stale_indexed_documents" : null
].filter(Boolean);
const findingSummary = mergeSeverityCounts(anomalySummary, hiddenDocumentSummary, latestRunSummary);
const currentHealthState = healthState({
  activeRunCount: runsSummary.active,
  findingSummary,
  queryErrors: Object.keys(queryErrors),
  strictFailures
});

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
  health: {
    state: currentHealthState,
    summary: findingSummary,
    structural_summary: anomalySummary,
    latest_run_summary: latestRunSummary,
    transient_stale_after_h: transientStaleHours
  },
  counts,
  anomalies: classifiedAnomalies.slice(0, 50),
  documents: {
    hidden: hiddenDocuments.slice(0, 20),
    summary: documentSummary(documents, hiddenDocuments)
  },
  runs: runsSummary,
  run_findings: latestRunFindings.slice(0, 20),
  query_errors: queryErrors,
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
  findingSummary.critical > 0 ||
  Object.keys(output.query_errors).length > 0 ||
  (strict && (findingSummary.warning > 0 || strictFailures.length > 0))
) {
  process.exitCode = 1;
}
