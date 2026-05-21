import type {
  DocumentRow,
  DocumentStatus,
  IndexingEventRow,
  IndexingRunRow,
  IndexingRunStatus
} from "@/lib/documents";
import { deleteRedisKey, getRedisJson, positiveIntegerEnv, setRedisJson } from "@/lib/redis";

export type TreeRow = {
  created_at: string;
  indexing_pipeline_version: string | null;
  model: string | null;
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

const TERMINAL_DOCUMENT_STATUSES = new Set<DocumentStatus>(["archived", "failed", "indexed"]);
const TERMINAL_RUN_STATUSES = new Set<IndexingRunStatus>(["canceled", "completed", "failed"]);

function documentDetailCacheKey(tenantId: string, documentId: string) {
  return ["document-detail", tenantId, documentId];
}

export function documentDetailCacheTtlSeconds() {
  return positiveIntegerEnv("DOCUMENT_DETAIL_CACHE_TTL_SECONDS", 60);
}

export function isDocumentDetailSnapshotCacheable(snapshot: DocumentDetailSnapshot) {
  if (!TERMINAL_DOCUMENT_STATUSES.has(snapshot.document.status)) {
    return false;
  }

  return !snapshot.latestRun || TERMINAL_RUN_STATUSES.has(snapshot.latestRun.status);
}

export async function getDocumentDetailSnapshotCache(input: {
  documentId: string;
  tenantId: string;
}) {
  return getRedisJson<DocumentDetailSnapshot>(
    documentDetailCacheKey(input.tenantId, input.documentId)
  );
}

export async function setDocumentDetailSnapshotCache(
  input: {
    documentId: string;
    tenantId: string;
  },
  snapshot: DocumentDetailSnapshot
) {
  if (!isDocumentDetailSnapshotCacheable(snapshot)) {
    return { configured: false, skipped: true, stored: false };
  }

  return setRedisJson(
    documentDetailCacheKey(input.tenantId, input.documentId),
    snapshot,
    documentDetailCacheTtlSeconds()
  );
}

export async function invalidateDocumentDetailSnapshotCache(input: {
  documentId: string;
  tenantId: string;
}) {
  return deleteRedisKey(documentDetailCacheKey(input.tenantId, input.documentId));
}
