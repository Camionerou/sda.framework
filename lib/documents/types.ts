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
  status: DocumentStatus;
  status_reason: string | null;
  storage_bucket: string;
  storage_path: string;
  title: string | null;
  tree_indexer_version: string | null;
  uploaded_at: string | null;
};

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

export type DocumentExtractionStatus =
  | "canceled"
  | "failed"
  | "queued"
  | "reused"
  | "running"
  | "succeeded";

export type DocumentExtractionRow = {
  artifact_prefix: string;
  completed_at: string | null;
  created_at: string;
  document_id: string;
  error_message: string | null;
  failed_at: string | null;
  id: string;
  manifest: Record<string, unknown>;
  metrics: Record<string, unknown>;
  parser: string;
  parser_backend: string;
  parser_version: string;
  run_id: string | null;
  started_at: string | null;
  status: DocumentExtractionStatus;
  updated_at: string;
};

export type DocumentExtractionArtifactRow = {
  artifact_type: string;
  byte_size: number | null;
  content_type: string | null;
  created_at: string;
  document_id: string;
  extraction_id: string;
  id: string;
  storage_bucket: string;
  storage_path: string;
};
