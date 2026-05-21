export type ComputeGatewayDocumentRef = {
  byte_size: number | null;
  filename: string;
  mime_type: string;
  r2_bucket: string;
  r2_key: string;
  signed_url: string;
};

export type ComputeGatewayIndexJobRequest = {
  document: ComputeGatewayDocumentRef;
  document_id: string;
  run_id: string;
  source: string;
  tenant_id: string;
  versions?: Record<string, string>;
};

export type ComputeGatewayIndexJobResponse = {
  job_id: string;
  metadata?: Record<string, unknown>;
  queue?: {
    active: number;
    concurrency: number;
    pending: number;
  };
  stage?: string;
  status?: string;
};

export type ComputeGatewayTreeIndexJobRequest = {
  document_id: string;
  document_title?: string | null;
  extraction_id: string;
  filename?: string | null;
  run_id: string;
  source: string;
  tenant_id: string;
  versions?: Record<string, string>;
};

export type ComputeGatewayTreeIndexJobResponse = {
  job_id: string;
  stage?: string;
  status?: string;
};

export type ComputeGatewayArtifact = {
  artifact_type: string;
  byte_size: number;
  checksum_sha256: string;
  content_type: string;
  relative_path: string;
  storage_bucket: string;
  storage_path: string;
};

export type ComputeGatewayIndexJobStatus = {
  artifact_bucket?: string;
  artifact_count?: number;
  artifact_prefix?: string;
  artifacts?: ComputeGatewayArtifact[];
  completed_at?: string;
  created_at: string;
  document_id: string;
  error?: string;
  failed_at?: string;
  job_id: string;
  manifest?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  message?: string;
  mineru_backend?: string;
  mineru_lang?: string;
  mineru_version?: string;
  progress: number;
  run_id: string;
  stage: string;
  started_at?: string;
  status: "queued" | "running" | "succeeded" | "failed" | string;
  tenant_id: string;
  updated_at: string;
  versions?: Record<string, string>;
};

export type ComputeGatewayTreeIndexJobStatus = {
  artifact_count?: number;
  chunk_count?: number;
  completed_at?: string;
  content_list_path?: string;
  created_at: string;
  doc_summary?: string;
  document_id: string;
  error?: string;
  failed_at?: string;
  extraction_id: string;
  job_id: string;
  message?: string;
  metrics?: Record<string, unknown>;
  model?: string;
  page_count?: number;
  persisted_at?: string;
  progress: number;
  provider?: string;
  run_id: string;
  source: string;
  stage: string;
  status: "queued" | "running" | "succeeded" | "failed" | string;
  tenant_id: string;
  updated_at: string;
  version?: string;
  versions?: Record<string, string>;
};
