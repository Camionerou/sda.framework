import type { DocumentDetailSnapshot } from "@/lib/documents/detail";
import {
  deleteRedisKey,
  getRedisJson,
  positiveIntegerEnv,
  setRedisJson
} from "@/lib/redis/client";

export function documentDetailCacheTtlSeconds() {
  return positiveIntegerEnv("DOCUMENT_DETAIL_CACHE_TTL_SECONDS", 60);
}

function documentDetailCacheKey(input: { documentId: string; tenantId: string }) {
  return ["document-detail", input.tenantId, input.documentId];
}

export function readDocumentDetailSnapshotCache(input: {
  documentId: string;
  tenantId: string;
}) {
  return getRedisJson<DocumentDetailSnapshot>(documentDetailCacheKey(input));
}

export function writeDocumentDetailSnapshotCache(input: {
  documentId: string;
  snapshot: DocumentDetailSnapshot;
  tenantId: string;
}) {
  return setRedisJson(
    documentDetailCacheKey(input),
    input.snapshot,
    documentDetailCacheTtlSeconds()
  );
}

export function deleteDocumentDetailSnapshotCache(input: {
  documentId: string;
  tenantId: string;
}) {
  return deleteRedisKey(documentDetailCacheKey(input));
}
