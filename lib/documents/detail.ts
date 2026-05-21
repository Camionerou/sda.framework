import { revalidateTag, unstable_cache } from "next/cache";

import type { DocumentRow, IndexingEventRow, IndexingRunRow } from "@/lib/documents/types";
import { visibleDocumentStatuses } from "@/lib/documents/visibility";
import { SYSTEM_COMPONENT_VERSION_ROWS } from "@/lib/system-versions";
import { createAdminClient } from "@/lib/supabase/admin";

export type TreeRow = {
  created_at: string;
  indexing_pipeline_version: string | null;
  model: string | null;
  routing_summary: string | null;
  summary: string | null;
  tree_indexer_version: string | null;
  tree_prompt_version: string | null;
  version: string | null;
};

export type ComponentVersionRow = {
  component: string;
  version: string;
};

export type DocumentDetailSnapshot = {
  chunks: {
    count: number;
    error?: string;
  };
  componentVersions: ComponentVersionRow[];
  document: DocumentRow;
  indexingEvents: IndexingEventRow[];
  latestRun: IndexingRunRow | null;
  tree: TreeRow | null;
};

const DOCUMENT_DETAIL_TAG = "document-detail";

async function countRows(documentId: string, tenantId: string) {
  const supabase = createAdminClient();
  const { count, error } = await supabase
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("tenant_id", tenantId);

  return {
    count: count ?? 0,
    error: error?.message
  };
}

async function fetchDocumentDetailSnapshot(
  documentId: string,
  tenantId: string
): Promise<DocumentDetailSnapshot | null> {
  const supabase = createAdminClient();
  const { data: document, error } = await supabase
    .from("documents")
    .select(
      "id, title, filename, mime_type, byte_size, storage_bucket, storage_path, status, status_reason, uploaded_at, indexed_at, created_at, indexing_pipeline_version, extraction_pipeline_version, tree_indexer_version, embedding_pipeline_version"
    )
    .eq("id", documentId)
    .eq("tenant_id", tenantId)
    .in("status", [...visibleDocumentStatuses])
    .not("uploaded_at", "is", null)
    .maybeSingle<DocumentRow>();

  if (error) {
    throw error;
  }

  if (!document) {
    return null;
  }

  const [
    { data: tree },
    chunks,
    { data: indexingRuns },
    { data: indexingEvents }
  ] = await Promise.all([
    supabase
      .from("doc_tree")
      .select(
        "summary, routing_summary, model, version, created_at, indexing_pipeline_version, tree_indexer_version, tree_prompt_version"
      )
      .eq("document_id", document.id)
      .eq("tenant_id", tenantId)
      .maybeSingle<TreeRow>(),
    countRows(document.id, tenantId),
    supabase
      .from("indexing_runs")
      .select(
        "id, document_id, status, stage, progress, attempt, created_at, started_at, completed_at, failed_at, error_message, compute_job_id, inngest_run_id, indexing_pipeline_version, extraction_pipeline_version, tree_indexer_version, embedding_pipeline_version"
      )
      .eq("document_id", document.id)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1)
      .returns<IndexingRunRow[]>(),
    supabase
      .from("indexing_events")
      .select("id, run_id, document_id, event_type, stage, severity, message, progress, created_at")
      .eq("document_id", document.id)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true })
      .limit(80)
      .returns<IndexingEventRow[]>()
  ]);

  return {
    chunks,
    componentVersions: SYSTEM_COMPONENT_VERSION_ROWS,
    document,
    indexingEvents: indexingEvents ?? [],
    latestRun: indexingRuns?.[0] ?? null,
    tree: tree ?? null
  };
}

const getCachedDocumentDetailSnapshot = unstable_cache(
  fetchDocumentDetailSnapshot,
  [DOCUMENT_DETAIL_TAG],
  {
    revalidate: 60,
    tags: [DOCUMENT_DETAIL_TAG]
  }
);

export function getDocumentDetailSnapshot(input: {
  documentId: string;
  tenantId: string;
}) {
  return getCachedDocumentDetailSnapshot(input.documentId, input.tenantId);
}

export function revalidateDocumentDetailSnapshotCache() {
  revalidateTag(DOCUMENT_DETAIL_TAG, { expire: 0 });
}
