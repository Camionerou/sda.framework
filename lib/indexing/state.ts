import {
  recordIndexingRunSnapshot,
  releaseIndexingTenantActiveRun
} from "@/lib/indexing/redis";
import { createAdminClient } from "@/lib/supabase/admin";

type IndexingEventSeverity = "debug" | "error" | "info" | "warning";

type IndexingTransitionInput = {
  document?: Record<string, unknown>;
  documentId: string;
  event: {
    eventType: string;
    message: string;
    metadata?: Record<string, unknown>;
    severity: IndexingEventSeverity;
  };
  progress: number;
  releaseActiveRun?: boolean;
  run?: Record<string, unknown>;
  runId: string;
  stage: string;
  status: string;
  tenantId: string;
};

type SupabaseWriteResult = {
  error: { message?: string } | null;
};

function throwFirstError(errors: SupabaseWriteResult[]) {
  const first = errors.find((result) => result.error)?.error;

  if (first) {
    throw first;
  }
}

export async function recordIndexingTransition(input: IndexingTransitionInput) {
  const supabase = createAdminClient();
  const operations: Array<PromiseLike<SupabaseWriteResult>> = [
    supabase.from("indexing_events").insert({
      document_id: input.documentId,
      event_type: input.event.eventType,
      metadata: input.event.metadata ?? {},
      message: input.event.message,
      progress: input.progress,
      run_id: input.runId,
      severity: input.event.severity,
      stage: input.stage,
      tenant_id: input.tenantId
    })
  ];

  if (input.run) {
    operations.push(
      supabase
        .from("indexing_runs")
        .update(input.run)
        .eq("id", input.runId)
        .eq("tenant_id", input.tenantId)
    );
  }

  if (input.document) {
    operations.push(
      supabase
        .from("documents")
        .update(input.document)
        .eq("id", input.documentId)
        .eq("tenant_id", input.tenantId)
    );
  }

  const results = await Promise.all(operations);

  throwFirstError(results);

  const snapshot = recordIndexingRunSnapshot({
    documentId: input.documentId,
    eventType: input.event.eventType,
    message: input.event.message,
    progress: input.progress,
    runId: input.runId,
    stage: input.stage,
    status: input.status,
    tenantId: input.tenantId
  });

  if (input.releaseActiveRun) {
    await Promise.all([
      snapshot,
      releaseIndexingTenantActiveRun({
        runId: input.runId,
        tenantId: input.tenantId
      })
    ]);
    return;
  }

  await snapshot;
}

export async function recordPermanentIndexingFailure(input: {
  documentId: string;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  progress?: number;
  runId: string;
  tenantId: string;
}) {
  const now = new Date().toISOString();
  const progress = input.progress ?? 100;

  await recordIndexingTransition({
    document: {
      status: "failed",
      status_reason: input.message
    },
    documentId: input.documentId,
    event: {
      eventType: input.eventType,
      message: input.message,
      metadata: input.metadata,
      severity: "error"
    },
    progress,
    releaseActiveRun: true,
    run: {
      error_message: input.message,
      failed_at: now,
      progress,
      stage: "failed",
      status: "failed"
    },
    runId: input.runId,
    stage: "failed",
    status: "failed",
    tenantId: input.tenantId
  });
}
