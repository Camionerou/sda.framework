import { createClient } from "@supabase/supabase-js";
import { Redis } from "@upstash/redis";

import { loadEnvFiles } from "../shared/env-loader.mjs";

loadEnvFiles([".env.local", ".env"], { override: true });

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

const now = Date.now();

function ageHours(value) {
  if (!value) {
    return null;
  }

  return Math.round(((now - Date.parse(value)) / 3_600_000) * 10) / 10;
}

function shortId(value) {
  return value ? String(value).slice(0, 8) : null;
}

function groupBy(rows, key) {
  return rows.reduce((acc, row) => {
    const value = row[key] ?? "null";
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function cleanRedisKeyPart(value) {
  return String(value).replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 180) || "unknown";
}

function redisKeyPrefix() {
  const env = process.env.VERCEL_ENV || process.env.NODE_ENV || "local";

  return process.env.UPSTASH_REDIS_KEY_PREFIX?.trim() || `sda:${cleanRedisKeyPart(env)}`;
}

function redisKey(...parts) {
  return [redisKeyPrefix(), ...parts.map(cleanRedisKeyPart)].join(":");
}

function summarizeHeartbeat(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    age_s: value.at ? Math.max(0, Math.round((now - Date.parse(value.at)) / 1000)) : null,
    at: value.at ?? null,
    metadata: value.metadata ?? null,
    service: value.service ?? null
  };
}

function summarizeRunSnapshot(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    age_s: value.updated_at
      ? Math.max(0, Math.round((now - Date.parse(value.updated_at)) / 1000))
      : null,
    doc: shortId(value.document_id),
    event_type: value.event_type ?? null,
    progress: value.progress ?? null,
    run: shortId(value.run_id),
    stage: value.stage ?? null,
    status: value.status ?? null,
    tenant: shortId(value.tenant_id),
    updated_at: value.updated_at ?? null
  };
}

async function redisOperationalState(tenantIds) {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (!url || !token) {
    return { configured: false };
  }

  const redis = new Redis({ token, url });
  const uniqueTenantIds = [...new Set(tenantIds.filter(Boolean))].slice(0, 20);

  try {
    const [apiHeartbeat, workflowHeartbeat, latestSnapshot] = await Promise.all([
      redis.get(redisKey("heartbeat", "indexing-api")),
      redis.get(redisKey("heartbeat", "indexing-workflow")),
      redis.get(redisKey("cache", "indexing-latest"))
    ]);
    const activeRunsByTenant = {};

    for (const tenantId of uniqueTenantIds) {
      const key = redisKey("indexing", "tenant-active", tenantId);

      await redis.zremrangebyscore(key, 0, now);
      activeRunsByTenant[shortId(tenantId)] = await redis.zcard(key);
    }

    return {
      active_runs_by_tenant: activeRunsByTenant,
      configured: true,
      heartbeats: {
        indexing_api: summarizeHeartbeat(apiHeartbeat),
        indexing_workflow: summarizeHeartbeat(workflowHeartbeat)
      },
      latest_run_snapshot: summarizeRunSnapshot(latestSnapshot),
      ok: true
    };
  } catch (error) {
    return {
      configured: true,
      error: error instanceof Error ? error.message : "unknown redis health error",
      ok: false
    };
  }
}

async function selectRows(table, columns, { limit = 1000, order = "created_at" } = {}) {
  let query = supabase.from(table).select(columns).limit(limit);

  if (order) {
    query = query.order(order, { ascending: false });
  }

  const { data, error } = await query;

  if (error) {
    return { error: error.message, rows: [] };
  }

  return { rows: data ?? [] };
}

async function countRows(table, column) {
  const { count, error } = await supabase
    .from(table)
    .select(column, { count: "exact", head: true });

  return error ? { error: error.message } : count;
}

const [
  documentsResult,
  runsResult,
  eventsResult,
  extractionsResult,
  treesResult,
  chunksResult,
  componentVersionsResult
] = await Promise.all([
  selectRows(
    "documents",
    "id,tenant_id,filename,status,status_reason,uploaded_at,indexed_at,created_at,updated_at,indexing_pipeline_version,extraction_pipeline_version,tree_indexer_version,embedding_pipeline_version",
    { limit: 1000 }
  ),
  selectRows(
    "indexing_runs",
    "id,tenant_id,document_id,status,stage,progress,attempt,inngest_run_id,compute_job_id,error_message,created_at,updated_at,indexing_pipeline_version,extraction_pipeline_version,tree_indexer_version,embedding_pipeline_version",
    { limit: 1000 }
  ),
  selectRows(
    "indexing_events",
    "id,tenant_id,document_id,run_id,event_type,stage,severity,message,progress,created_at",
    { limit: 500 }
  ),
  selectRows(
    "document_extractions",
    "id,tenant_id,document_id,run_id,status,parser,parser_version,error_message,created_at,updated_at,indexing_pipeline_version,extraction_pipeline_version",
    { limit: 1000 }
  ),
  selectRows(
    "doc_tree",
    "tenant_id,document_id,model,version,summary,created_at,updated_at,indexing_pipeline_version,tree_indexer_version,tree_prompt_version",
    {
      limit: 1000,
      order: "updated_at"
    }
  ),
  selectRows(
    "chunks",
    "id,tenant_id,document_id,chunk_index,page_start,page_end,embedding_model,created_at,updated_at,indexing_pipeline_version,tree_indexer_version,embedding_pipeline_version",
    { limit: 5000 }
  ),
  selectRows(
    "system_component_versions",
    "component,version,description,updated_at",
    { limit: 100, order: "component" }
  )
]);

const [documentCount, runCount, eventCount, treeCount, chunkCount] = await Promise.all([
  countRows("documents", "id"),
  countRows("indexing_runs", "id"),
  countRows("indexing_events", "id"),
  countRows("doc_tree", "document_id"),
  countRows("chunks", "id")
]);

const documents = documentsResult.rows;
const runs = runsResult.rows;
const events = eventsResult.rows;
const extractions = extractionsResult.rows;
const trees = treesResult.rows;
const chunks = chunksResult.rows;
const latestVersions = Object.fromEntries(
  componentVersionsResult.rows.map((row) => [row.component, row.version])
);

const activeRuns = runs.filter((run) => ["queued", "running"].includes(run.status));
const activeRunKeys = new Set(activeRuns.map((run) => `${run.tenant_id}:${run.document_id}`));
const treeKeys = new Set(trees.map((tree) => `${tree.tenant_id}:${tree.document_id}`));
const REINDEX_REQUIRED_COMPONENTS = new Set([
  "extraction_pipeline",
  "indexing_pipeline",
  "tree_indexer_python"
]);
const chunksByDocument = chunks.reduce((acc, chunk) => {
  const key = `${chunk.tenant_id}:${chunk.document_id}`;
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

function sampleDocuments(rows) {
  return rows.slice(0, 10).map((document) => ({
    id: shortId(document.id),
    file: document.filename,
    status: document.status,
    reason: document.status_reason,
    updated_age_h: ageHours(document.updated_at),
    has_tree: treeKeys.has(`${document.tenant_id}:${document.id}`),
    chunks: chunksByDocument[`${document.tenant_id}:${document.id}`] ?? 0
  }));
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

  return checks
    .map(([component, current]) => ({
      component,
      current: current ?? null,
      latest: latestVersions[component] ?? null,
      requires_reindex: REINDEX_REQUIRED_COMPONENTS.has(component)
    }))
    .filter((check) => check.current && check.latest && check.current !== check.latest);
}

function sampleVersionDrift(rows) {
  return rows.slice(0, 10).map((document) => ({
    drift: versionDrift(document),
    file: document.filename,
    id: shortId(document.id),
    indexed_age_h: ageHours(document.indexed_at),
    status: document.status
  }));
}

function sampleRuns(rows) {
  return rows.slice(0, 10).map((run) => ({
    id: shortId(run.id),
    doc: shortId(run.document_id),
    status: run.status,
    stage: run.stage,
    progress: run.progress,
    updated_age_h: ageHours(run.updated_at),
    has_inngest_run_id: Boolean(run.inngest_run_id),
    has_compute_job_id: Boolean(run.compute_job_id),
    error: run.error_message
  }));
}

const anomalies = {
  uploaded_without_active_run: documents.filter(
    (document) =>
      document.status === "uploaded" &&
      document.uploaded_at &&
      !activeRunKeys.has(`${document.tenant_id}:${document.id}`)
  ),
  nonterminal_without_active_run: documents.filter(
    (document) =>
      ["queued", "parsing", "structuring"].includes(document.status) &&
      document.uploaded_at &&
      !activeRunKeys.has(`${document.tenant_id}:${document.id}`)
  ),
  active_run_without_uploaded_at: activeRuns.filter((run) => {
    const document = documents.find(
      (item) => item.id === run.document_id && item.tenant_id === run.tenant_id
    );

    return document && !document.uploaded_at;
  }),
  indexed_without_tree: documents.filter(
    (document) => document.status === "indexed" && !treeKeys.has(`${document.tenant_id}:${document.id}`)
  ),
  indexed_without_chunks: documents.filter(
    (document) => document.status === "indexed" && !chunksByDocument[`${document.tenant_id}:${document.id}`]
  ),
  running_with_persisted_tree: activeRuns.filter((run) => {
    const key = `${run.tenant_id}:${run.document_id}`;

    return treeKeys.has(key) && (chunksByDocument[key] ?? 0) > 0;
  })
};
const recentErrorEvents = events.filter((event) => event.severity === "error");
const versionDriftDocuments = documents.filter((document) => versionDrift(document).length > 0);
const reindexRequiredDocuments = versionDriftDocuments.filter((document) =>
  versionDrift(document).some((drift) => drift.requires_reindex)
);
const redis = await redisOperationalState([
  ...documents.map((document) => document.tenant_id),
  ...runs.map((run) => run.tenant_id)
]);
const env = {
  admin_public_url_mismatch: Boolean(adminUrl && publicUrl && adminUrl !== publicUrl),
  compute_gateway_configured: Boolean(process.env.COMPUTE_GATEWAY_URL),
  inngest_api_key_configured: Boolean(process.env.INNGEST_API_KEY),
  inngest_event_key_configured: Boolean(process.env.INNGEST_EVENT_KEY),
  redis_configured: Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ),
  supabase_host: new URL(url).host
};
const strictFailures = [
  env.admin_public_url_mismatch ? "admin_public_url_mismatch" : null,
  !env.compute_gateway_configured ? "compute_gateway_not_configured" : null,
  !env.inngest_event_key_configured ? "inngest_event_key_not_configured" : null,
  requireFreshIndexes && reindexRequiredDocuments.length > 0 ? "stale_indexed_documents" : null
].filter(Boolean);

const output = {
  env,
  redis,
  counts: {
    chunks: chunkCount,
    doc_tree: treeCount,
    documents: documentCount,
    indexing_events: eventCount,
    indexing_runs: runCount
  },
  distributions: {
    documents_by_status: groupBy(documents, "status"),
    events_by_severity_recent: groupBy(events, "severity"),
    extractions_by_status: groupBy(extractions, "status"),
    runs_by_stage: groupBy(runs, "stage"),
    runs_by_status: groupBy(runs, "status")
  },
  versions: {
    indexed_document_version_drift: sampleVersionDrift(versionDriftDocuments),
    indexed_document_version_drift_count: versionDriftDocuments.length,
    indexed_document_reindex_required: sampleVersionDrift(reindexRequiredDocuments),
    indexed_document_reindex_required_count: reindexRequiredDocuments.length,
    latest: latestVersions,
  },
  anomalies: {
    active_run_without_uploaded_at: sampleRuns(anomalies.active_run_without_uploaded_at),
    indexed_without_chunks: sampleDocuments(anomalies.indexed_without_chunks),
    indexed_without_tree: sampleDocuments(anomalies.indexed_without_tree),
    nonterminal_without_active_run: sampleDocuments(anomalies.nonterminal_without_active_run),
    running_with_persisted_tree: sampleRuns(anomalies.running_with_persisted_tree),
    uploaded_without_active_run: sampleDocuments(anomalies.uploaded_without_active_run)
  },
  query_errors: Object.fromEntries(
    Object.entries({
      chunks: chunksResult.error,
      documents: documentsResult.error,
      events: eventsResult.error,
      extractions: extractionsResult.error,
      versions: componentVersionsResult.error,
      runs: runsResult.error,
      trees: treesResult.error
    }).filter(([, value]) => value)
  ),
  signals: {
    recent_error_events: recentErrorEvents.slice(0, 10).map((event) => ({
      age_h: ageHours(event.created_at),
      doc: shortId(event.document_id),
      message: event.message,
      run: shortId(event.run_id),
      stage: event.stage,
      type: event.event_type
    })),
    indexed_document_version_drift: sampleVersionDrift(versionDriftDocuments)
  },
  strict: {
    enabled: strict,
    failures: strictFailures,
    require_fresh_indexes: requireFreshIndexes
  }
};

console.log(JSON.stringify(output, null, 2));

if (
  Object.values(anomalies).some((value) => Array.isArray(value) && value.length > 0) ||
  Object.keys(output.query_errors).length > 0 ||
  (strict && strictFailures.length > 0)
) {
  process.exitCode = 1;
}
