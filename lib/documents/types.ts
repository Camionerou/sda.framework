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
