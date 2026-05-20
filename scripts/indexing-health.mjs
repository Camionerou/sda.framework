import { readFileSync, existsSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

const ENV_FILES = [".env.local", ".env"];

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);

    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    let value = rawValue.trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] ??= value;
  }
}

for (const path of ENV_FILES) {
  loadEnvFile(path);
}

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
  chunksResult
] = await Promise.all([
  selectRows(
    "documents",
    "id,tenant_id,filename,status,status_reason,uploaded_at,indexed_at,created_at,updated_at",
    { limit: 1000 }
  ),
  selectRows(
    "indexing_runs",
    "id,tenant_id,document_id,status,stage,progress,attempt,inngest_run_id,compute_job_id,error_message,created_at,updated_at",
    { limit: 1000 }
  ),
  selectRows(
    "indexing_events",
    "id,tenant_id,document_id,run_id,event_type,stage,severity,message,progress,created_at",
    { limit: 500 }
  ),
  selectRows(
    "document_extractions",
    "id,tenant_id,document_id,run_id,status,parser,parser_version,error_message,created_at,updated_at",
    { limit: 1000 }
  ),
  selectRows("doc_tree", "tenant_id,document_id,model,version,summary,created_at,updated_at", {
    limit: 1000,
    order: "updated_at"
  }),
  selectRows(
    "chunks",
    "id,tenant_id,document_id,chunk_index,page_start,page_end,embedding_model,created_at,updated_at",
    { limit: 5000 }
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

const activeRuns = runs.filter((run) => ["queued", "running"].includes(run.status));
const activeRunKeys = new Set(activeRuns.map((run) => `${run.tenant_id}:${run.document_id}`));
const treeKeys = new Set(trees.map((tree) => `${tree.tenant_id}:${tree.document_id}`));
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

const output = {
  env: {
    admin_public_url_mismatch: Boolean(adminUrl && publicUrl && adminUrl !== publicUrl),
    compute_gateway_configured: Boolean(process.env.COMPUTE_GATEWAY_URL),
    inngest_api_key_configured: Boolean(process.env.INNGEST_API_KEY),
    inngest_event_key_configured: Boolean(process.env.INNGEST_EVENT_KEY),
    supabase_host: new URL(url).host
  },
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
  anomalies: {
    active_run_without_uploaded_at: sampleRuns(anomalies.active_run_without_uploaded_at),
    indexed_without_chunks: sampleDocuments(anomalies.indexed_without_chunks),
    indexed_without_tree: sampleDocuments(anomalies.indexed_without_tree),
    running_with_persisted_tree: sampleRuns(anomalies.running_with_persisted_tree),
    uploaded_without_active_run: sampleDocuments(anomalies.uploaded_without_active_run)
  },
  query_errors: Object.fromEntries(
    Object.entries({
      chunks: chunksResult.error,
      documents: documentsResult.error,
      events: eventsResult.error,
      extractions: extractionsResult.error,
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
    }))
  }
};

console.log(JSON.stringify(output, null, 2));

if (
  Object.values(anomalies).some((value) => Array.isArray(value) && value.length > 0) ||
  Object.keys(output.query_errors).length > 0
) {
  process.exitCode = 1;
}
