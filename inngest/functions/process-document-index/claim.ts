import { recordIndexingTransition, recordPermanentIndexingFailure } from "@/lib/indexing/state";
import { createAdminClient } from "@/lib/supabase/admin";
import { INDEXING_VERSION_COLUMNS, INDEXING_VERSION_METADATA } from "@/lib/system-versions";

import type {
  DocumentForIndexing,
  IndexingRunClaim,
  ProcessDocumentIndexEvent,
  StepLike
} from "./types";

export async function claimIndexingRun(input: {
  event: ProcessDocumentIndexEvent;
  executionRunId: string;
  step: StepLike;
}) {
  const { event, executionRunId, step } = input;

  return step.run("claim-indexing-run", async () => {
    const supabase = createAdminClient();
    const now = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from("indexing_runs")
      .update({
        error_message: null,
        ...INDEXING_VERSION_COLUMNS,
        inngest_run_id: executionRunId,
        progress: 1,
        stage: "queued",
        started_at: now,
        status: "running"
      })
      .eq("id", event.data.run_id)
      .eq("tenant_id", event.data.tenant_id)
      .eq("status", "queued")
      .select("id, compute_job_id, inngest_run_id, progress, stage, status")
      .maybeSingle<IndexingRunClaim>();

    if (claimError) {
      throw claimError;
    }

    if (claimed) {
      return {
        computeJobId: claimed.compute_job_id,
        progress: claimed.progress,
        reason: "claimed",
        shouldProcess: true,
        stage: claimed.stage,
        status: claimed.status
      };
    }

    const { data: existing, error: existingError } = await supabase
      .from("indexing_runs")
      .select("id, compute_job_id, inngest_run_id, progress, stage, status")
      .eq("id", event.data.run_id)
      .eq("tenant_id", event.data.tenant_id)
      .maybeSingle<IndexingRunClaim>();

    if (existingError) {
      throw existingError;
    }

    if (existing?.status === "running" && existing.inngest_run_id === executionRunId) {
      return {
        computeJobId: existing.compute_job_id,
        progress: existing.progress,
        reason: "retry_same_event",
        shouldProcess: true,
        stage: existing.stage,
        status: existing.status
      };
    }

    if (existing) {
      await recordIndexingTransition({
        documentId: event.data.document_id,
        event: {
          eventType: "indexing.orchestrator.skipped",
          message: "Evento de indexacion duplicado ignorado",
          metadata: {
            current_inngest_event_id: existing.inngest_run_id,
            incoming_inngest_event_id: executionRunId,
            reason: "run_already_claimed_or_terminal",
            source: event.data.source
          },
          severity: "debug"
        },
        progress: existing.progress,
        releaseActiveRun: ["canceled", "completed", "failed"].includes(existing.status),
        runId: event.data.run_id,
        stage: existing.stage,
        status: existing.status,
        tenantId: event.data.tenant_id
      });
    }

    return {
      computeJobId: existing?.compute_job_id ?? null,
      progress: existing?.progress ?? 0,
      reason: existing ? "already_claimed_or_terminal" : "run_not_found",
      shouldProcess: false,
      stage: existing?.stage ?? "missing",
      status: existing?.status ?? "missing"
    };
  });
}

export async function recordOrchestratorReceived(input: {
  event: ProcessDocumentIndexEvent;
  executionRunId: string;
  step: StepLike;
}) {
  const { event, executionRunId, step } = input;

  await step.run("record-orchestrator-received", async () => {
    await recordIndexingTransition({
      documentId: event.data.document_id,
      event: {
        eventType: "indexing.orchestrator.received",
        message: "Inngest recibio la corrida de indexacion",
        metadata: {
          ...INDEXING_VERSION_METADATA,
          actor_id: event.data.actor_id,
          inngest_event_id: event.id,
          inngest_run_id: executionRunId,
          source: event.data.source
        },
        severity: "info"
      },
      progress: 0,
      runId: event.data.run_id,
      stage: "queued",
      status: "running",
      tenantId: event.data.tenant_id
    });
  });
}

export async function loadDocumentForIndexing(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
}) {
  const { event, step } = input;

  return step.run("load-document-for-indexing", async () => {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("documents")
      .select(
        "id, tenant_id, title, filename, mime_type, byte_size, checksum_sha256, r2_bucket, r2_key, status, uploaded_at"
      )
      .eq("id", event.data.document_id)
      .eq("tenant_id", event.data.tenant_id)
      .maybeSingle<DocumentForIndexing>();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new Error("Documento no encontrado para indexacion.");
    }

    return data;
  });
}

export async function recordDocumentUploadIncomplete(input: {
  document: DocumentForIndexing;
  event: ProcessDocumentIndexEvent;
  step: StepLike;
}) {
  const { document, event, step } = input;
  const message = "Upload incompleto: archivo no confirmado en Storage";

  await step.run("record-document-upload-incomplete", async () =>
    recordPermanentIndexingFailure({
      documentId: event.data.document_id,
      eventType: "indexing.storage_object_missing",
      message,
      metadata: {
        document_status: document.status,
        r2_bucket: document.r2_bucket,
        r2_key: document.r2_key,
        reason: "uploaded_at_missing"
      },
      runId: event.data.run_id,
      tenantId: event.data.tenant_id
    })
  );
}
