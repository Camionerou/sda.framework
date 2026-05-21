import type { DocumentIndexRequestedEvent } from "@/inngest/client";

export type DocumentForIndexing = {
  byte_size: number | null;
  checksum_sha256: string | null;
  filename: string;
  id: string;
  mime_type: string;
  status: string;
  storage_bucket: string;
  storage_path: string;
  tenant_id: string;
  title: string | null;
  uploaded_at: string | null;
};

export type IndexingRunClaim = {
  compute_job_id: string | null;
  id: string;
  inngest_run_id: string | null;
  progress: number;
  stage: string;
  status: string;
};

export type ProcessDocumentIndexEvent = {
  data: DocumentIndexRequestedEvent;
  id: string;
};

export type StepLike = {
  run<T>(id: string, handler: () => Promise<T> | T): Promise<T>;
  sleep(id: string, duration: string): Promise<void>;
  waitForEvent?<TData extends object>(
    id: string,
    options: {
      event: string;
      if: string;
      timeout: string;
    }
  ): Promise<{ data: TData } | null>;
};
