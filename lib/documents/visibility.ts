import type { DocumentRow, DocumentStatus } from "@/lib/documents/types";

export const visibleDocumentStatuses: readonly DocumentStatus[] = [
  "uploaded",
  "queued",
  "parsing",
  "structuring",
  "embedding",
  "indexed"
] as const;

export const pendingVisibleDocumentStatuses: readonly DocumentStatus[] = [
  "queued",
  "parsing",
  "structuring",
  "embedding"
] as const;

export function isVisibleDocument(document: Pick<DocumentRow, "status" | "uploaded_at">) {
  return Boolean(document.uploaded_at) && visibleDocumentStatuses.includes(document.status);
}

export function isPendingVisibleDocument(document: Pick<DocumentRow, "status">) {
  return pendingVisibleDocumentStatuses.includes(document.status);
}
