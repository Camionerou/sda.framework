export type DocumentStatus =
  | "archived"
  | "uploading"
  | "uploaded"
  | "queued"
  | "parsing"
  | "structuring"
  | "embedding"
  | "indexed"
  | "failed";

export type DocumentRow = {
  byte_size: number | null;
  created_at: string;
  embedding_pipeline_version: string | null;
  extraction_pipeline_version: string | null;
  filename: string;
  id: string;
  indexed_at: string | null;
  indexing_pipeline_version: string | null;
  mime_type: string;
  r2_bucket: string;
  r2_key: string;
  status: DocumentStatus;
  status_reason: string | null;
  title: string | null;
  tree_indexer_version: string | null;
  uploaded_at: string | null;
};

export function formatBytes(value: number | null) {
  if (!value) {
    return "Sin dato";
  }

  return new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: 1,
    style: "unit",
    unit: value >= 1024 * 1024 ? "megabyte" : "kilobyte",
    unitDisplay: "short"
  }).format(value >= 1024 * 1024 ? value / 1024 / 1024 : value / 1024);
}

export function documentStatusTone(status: DocumentStatus) {
  if (status === "uploaded" || status === "indexed") {
    return "success" as const;
  }

  if (status === "failed" || status === "archived") {
    return "danger" as const;
  }

  return "warning" as const;
}

export function documentStatusLabel(status: DocumentStatus) {
  const labels: Record<DocumentStatus, string> = {
    archived: "Archivado",
    embedding: "Embeddings",
    failed: "Falló",
    indexed: "Indexado",
    parsing: "Extrayendo",
    queued: "En cola",
    structuring: "Armando árbol",
    uploaded: "Subido",
    uploading: "Subiendo"
  };

  return labels[status];
}

export type IndexingRunStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type IndexingStage =
  | "queued"
  | "extracting"
  | "structuring"
  | "verifying_tree"
  | "refining_tree"
  | "summarizing"
  | "embedding"
  | "persisting"
  | "indexed"
  | "failed"
  | "canceled";

export type IndexingRunRow = {
  id: string;
  document_id: string;
  status: IndexingRunStatus;
  stage: IndexingStage;
  progress: number;
  attempt: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error_message: string | null;
  compute_job_id: string | null;
  embedding_pipeline_version: string;
  extraction_pipeline_version: string;
  inngest_run_id: string | null;
  indexing_pipeline_version: string;
  tree_indexer_version: string;
};

export type IndexingEventRow = {
  id: string;
  run_id: string;
  document_id: string;
  event_type: string;
  stage: IndexingStage | string;
  severity: "debug" | "info" | "warning" | "error";
  message: string;
  progress: number | null;
  created_at: string;
};

export function indexingStageLabel(stage: IndexingStage | string) {
  const labels: Record<IndexingStage, string> = {
    canceled: "Cancelado",
    embedding: "Generando embeddings",
    extracting: "Extrayendo documento",
    failed: "Falló",
    indexed: "Indexado",
    persisting: "Guardando índice",
    queued: "En cola",
    refining_tree: "Refinando árbol",
    structuring: "Armando árbol",
    summarizing: "Generando summaries",
    verifying_tree: "Verificando árbol"
  };

  return labels[stage as IndexingStage] ?? stage;
}

export function indexingRunTone(status: IndexingRunStatus) {
  if (status === "completed") {
    return "success" as const;
  }

  if (status === "failed" || status === "canceled") {
    return "danger" as const;
  }

  return "warning" as const;
}
