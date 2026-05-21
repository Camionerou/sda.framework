import {
  createComputeGatewayIndexJob,
  getComputeGatewayIndexJob,
  getSignedUrlTtlSeconds,
  isComputeGatewayConfigured,
  type ComputeGatewayIndexJobResponse,
  type ComputeGatewayIndexJobStatus
} from "@/lib/indexing/compute-gateway";
import { recordIndexingTransition, recordPermanentIndexingFailure } from "@/lib/indexing/state";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  INDEXING_VERSION_COLUMNS,
  INDEXING_VERSION_METADATA,
  SYSTEM_COMPONENT_VERSIONS
} from "@/lib/system-versions";

import {
  artifactRows,
  getArtifactPrefix,
  getExtractionPipelineVersion,
  getGatewayPollAttempts,
  getGatewayPollInterval,
  getIndexingPipelineVersion,
  getParserVersion,
  isStorageObjectMissingError,
  mapGatewayProgress,
  mapGatewayStage,
  messageFromError
} from "./helpers";
import type { DocumentForIndexing, ProcessDocumentIndexEvent, StepLike } from "./types";

export async function recordComputeGatewayPending(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
}) {
  const { event, step } = input;

  await step.run("record-compute-gateway-pending", async () => {
    await recordIndexingTransition({
      document: {
        status_reason: "Esperando Compute Gateway"
      },
      documentId: event.data.document_id,
      event: {
        eventType: "indexing.compute_gateway.pending",
        message: "Esperando Compute Gateway para ejecutar MinerU",
        metadata: {
          expected_worker: "mineru",
          host: "srv-ia-01"
        },
        severity: "info"
      },
      progress: 0,
      releaseActiveRun: true,
      run: {
        error_message: "Esperando Compute Gateway",
        progress: 0,
        stage: "queued",
        status: "queued"
      },
      runId: event.data.run_id,
      stage: "queued",
      status: "queued",
      tenantId: event.data.tenant_id
    });
  });
}

export function canUseComputeGateway() {
  return isComputeGatewayConfigured();
}

export async function recordComputeGatewayDispatching(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
}) {
  const { event, step } = input;

  await step.run("record-compute-gateway-dispatching", async () => {
    await recordIndexingTransition({
      document: {
        status: "parsing",
        status_reason: "Enviando documento al Compute Gateway"
      },
      documentId: event.data.document_id,
      event: {
        eventType: "indexing.compute_gateway.dispatching",
        message: "Enviando documento al Compute Gateway",
        metadata: {
          expected_worker: "mineru",
          host: "srv-ia-01"
        },
        severity: "info"
      },
      progress: 5,
      run: {
        error_message: null,
        progress: 5,
        stage: "extracting",
        started_at: new Date().toISOString(),
        status: "running"
      },
      runId: event.data.run_id,
      stage: "extracting",
      status: "running",
      tenantId: event.data.tenant_id
    });
  });
}

export async function dispatchComputeGatewayJob(input: {
  computeJobId: string | null;
  document: DocumentForIndexing;
  event: ProcessDocumentIndexEvent;
  step: StepLike;
}): Promise<ComputeGatewayIndexJobResponse | null> {
  const { computeJobId, document, event, step } = input;

  if (computeJobId) {
    return {
      job_id: computeJobId,
      stage: "resumed",
      status: "running"
    };
  }

  try {
    return await step.run("create-compute-gateway-job", async () => {
      const supabase = createAdminClient();
      const { data: signedUrl, error: signedUrlError } = await supabase.storage
        .from(document.r2_bucket)
        .createSignedUrl(document.r2_key, getSignedUrlTtlSeconds());

      if (signedUrlError) {
        throw signedUrlError;
      }

      if (!signedUrl?.signedUrl) {
        throw new Error("No se pudo firmar el documento para el Compute Gateway.");
      }

      return createComputeGatewayIndexJob({
        document: {
          byte_size: document.byte_size,
          filename: document.filename,
          mime_type: document.mime_type,
          r2_bucket: document.r2_bucket,
          r2_key: document.r2_key,
          signed_url: signedUrl.signedUrl
        },
        document_id: event.data.document_id,
        run_id: event.data.run_id,
        source: event.data.source,
        tenant_id: event.data.tenant_id,
        versions: INDEXING_VERSION_METADATA.versions
      });
    });
  } catch (dispatchError) {
    const message = messageFromError(dispatchError, "No se pudo crear el job en Compute Gateway.");
    const storageObjectMissing = isStorageObjectMissingError(dispatchError);

    await step.run("record-compute-gateway-dispatch-failed", async () => {
      if (storageObjectMissing) {
        await recordPermanentIndexingFailure({
          documentId: event.data.document_id,
          eventType: "indexing.storage_object_missing",
          message: "Upload incompleto: archivo no encontrado en Storage",
          metadata: {
            original_error: message,
            r2_bucket: document.r2_bucket,
            r2_key: document.r2_key,
            reason: "signed_url_failed"
          },
          runId: event.data.run_id,
          tenantId: event.data.tenant_id
        });
        return;
      }

      await recordIndexingTransition({
        document: {
          status: "parsing",
          status_reason: "Compute Gateway no recibio el job; Inngest puede reintentar"
        },
        documentId: event.data.document_id,
        event: {
          eventType: "indexing.compute_gateway.dispatch_failed",
          message,
          metadata: {
            retry_owner: "inngest"
          },
          severity: "error"
        },
        progress: 5,
        run: {
          error_message: message,
          progress: 5,
          stage: "extracting",
          status: "running"
        },
        runId: event.data.run_id,
        stage: "extracting",
        status: "running",
        tenantId: event.data.tenant_id
      });
    });

    if (storageObjectMissing) {
      return null;
    }

    throw dispatchError;
  }
}

export async function recordComputeGatewayJobCreated(input: {
  event: ProcessDocumentIndexEvent;
  gatewayJob: ComputeGatewayIndexJobResponse;
  step: StepLike;
}) {
  const { event, gatewayJob, step } = input;

  await step.run("record-compute-gateway-job-created", async () => {
    await recordIndexingTransition({
      document: {
        status: "parsing",
        status_reason: "Compute Gateway ejecutando MinerU"
      },
      documentId: event.data.document_id,
      event: {
        eventType: "indexing.compute_gateway.job_created",
        message: "Compute Gateway recibio el job de MinerU",
        metadata: {
          gateway_status: gatewayJob.status,
          job_id: gatewayJob.job_id
        },
        severity: "info"
      },
      progress: 8,
      run: {
        compute_job_id: gatewayJob.job_id,
        error_message: null,
        progress: 8,
        stage: "extracting",
        status: "running"
      },
      runId: event.data.run_id,
      stage: "extracting",
      status: "running",
      tenantId: event.data.tenant_id
    });
  });
}

export async function pollComputeGatewayJob(input: {
  event: ProcessDocumentIndexEvent;
  gatewayJob: ComputeGatewayIndexJobResponse;
  step: StepLike;
}) {
  const { event, gatewayJob, step } = input;
  const attempts = getGatewayPollAttempts();
  const interval = getGatewayPollInterval();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const currentJob = await step.run(`poll-compute-gateway-job-${attempt}`, async () =>
      getComputeGatewayIndexJob(gatewayJob.job_id)
    );

    if (currentJob.status === "succeeded" || currentJob.status === "failed") {
      return currentJob;
    }

    if (attempt === 1 || attempt % 4 === 0) {
      await step.run(`record-compute-gateway-progress-${attempt}`, async () => {
        const progress = mapGatewayProgress(currentJob);
        const stage = mapGatewayStage(currentJob);
        const message = currentJob.message ?? "Compute Gateway procesando MinerU";

        await recordIndexingTransition({
          document: {
            status: "parsing",
            status_reason: message
          },
          documentId: event.data.document_id,
          event: {
            eventType: "indexing.compute_gateway.progress",
            message,
            metadata: {
              gateway_progress: currentJob.progress,
              gateway_stage: currentJob.stage,
              gateway_status: currentJob.status,
              job_id: currentJob.job_id
            },
            severity: "info"
          },
          progress,
          run: {
            progress,
            stage,
            status: "running"
          },
          runId: event.data.run_id,
          stage,
          status: "running",
          tenantId: event.data.tenant_id
        });
      });
    }

    await step.sleep(`wait-compute-gateway-job-${attempt}`, interval);
  }

  throw new Error(`Compute Gateway job ${gatewayJob.job_id} no termino dentro del tiempo esperado.`);
}

export async function recordMineruExtractionFailed(input: {
  document: DocumentForIndexing;
  event: ProcessDocumentIndexEvent;
  step: StepLike;
  terminalGatewayJob: ComputeGatewayIndexJobStatus;
}) {
  const { document, event, step, terminalGatewayJob } = input;

  await step.run("record-mineru-extraction-failed", async () => {
    const supabase = createAdminClient();
    const parserVersion = getParserVersion(terminalGatewayJob);
    const message = terminalGatewayJob.error ?? "MinerU fallo en Compute Gateway.";
    const { error: extractionError } = await supabase.from("document_extractions").upsert(
      {
        artifact_bucket: terminalGatewayJob.artifact_bucket ?? document.r2_bucket,
        artifact_prefix: getArtifactPrefix(terminalGatewayJob, document, parserVersion),
        document_id: event.data.document_id,
        error_message: message,
        extraction_pipeline_version: INDEXING_VERSION_COLUMNS.extraction_pipeline_version,
        failed_at: terminalGatewayJob.failed_at ?? new Date().toISOString(),
        id: terminalGatewayJob.job_id,
        indexing_pipeline_version: INDEXING_VERSION_COLUMNS.indexing_pipeline_version,
        input_byte_size: document.byte_size,
        manifest: terminalGatewayJob.manifest ?? {},
        metrics: {
          gateway_progress: terminalGatewayJob.progress,
          gateway_stage: terminalGatewayJob.stage
        },
        parser: "mineru",
        parser_backend: terminalGatewayJob.mineru_backend ?? "pipeline",
        parser_version: parserVersion,
        run_id: event.data.run_id,
        source_checksum_sha256: document.checksum_sha256,
        source_r2_key: document.r2_key,
        status: "failed",
        tenant_id: event.data.tenant_id
      },
      { onConflict: "id" }
    );

    if (extractionError) {
      throw extractionError;
    }

    await recordIndexingTransition({
      document: {
        status: "failed",
        status_reason: message
      },
      documentId: event.data.document_id,
      event: {
        eventType: "indexing.extract.failed",
        message,
        metadata: {
          gateway_stage: terminalGatewayJob.stage,
          gateway_status: terminalGatewayJob.status,
          job_id: terminalGatewayJob.job_id
        },
        severity: "error"
      },
      progress: 100,
      releaseActiveRun: true,
      run: {
        error_message: message,
        failed_at: new Date().toISOString(),
        progress: 100,
        stage: "failed",
        status: "failed"
      },
      runId: event.data.run_id,
      stage: "failed",
      status: "failed",
      tenantId: event.data.tenant_id
    });
  });
}

export async function recordMineruExtractionSucceeded(input: {
  document: DocumentForIndexing;
  event: ProcessDocumentIndexEvent;
  step: StepLike;
  terminalGatewayJob: ComputeGatewayIndexJobStatus;
}) {
  const { document, event, step, terminalGatewayJob } = input;

  await step.run("record-mineru-extraction-succeeded", async () => {
    const supabase = createAdminClient();
    const parserVersion = getParserVersion(terminalGatewayJob);
    const extractionPipelineVersion = getExtractionPipelineVersion(terminalGatewayJob);
    const indexingPipelineVersion = getIndexingPipelineVersion(terminalGatewayJob);
    const artifacts = terminalGatewayJob.artifacts ?? [];

    if (artifacts.length === 0) {
      throw new Error("Compute Gateway no devolvio artefactos MinerU.");
    }

    const extractionRecord = {
      artifact_bucket: terminalGatewayJob.artifact_bucket ?? document.r2_bucket,
      artifact_prefix: getArtifactPrefix(terminalGatewayJob, document, parserVersion),
      completed_at: terminalGatewayJob.completed_at ?? new Date().toISOString(),
      document_id: event.data.document_id,
      extraction_pipeline_version: extractionPipelineVersion,
      id: terminalGatewayJob.job_id,
      indexing_pipeline_version: indexingPipelineVersion,
      input_byte_size: document.byte_size,
      manifest: terminalGatewayJob.manifest ?? {
        artifacts
      },
      metrics: {
        artifact_count: artifacts.length,
        compute_gateway_extraction_version: SYSTEM_COMPONENT_VERSIONS.compute_gateway_extraction,
        gateway_progress: terminalGatewayJob.progress,
        gateway_stage: terminalGatewayJob.stage
      },
      parser: "mineru",
      parser_backend: terminalGatewayJob.mineru_backend ?? "pipeline",
      parser_version: parserVersion,
      run_id: event.data.run_id,
      source_checksum_sha256: document.checksum_sha256,
      source_r2_key: document.r2_key,
      started_at: terminalGatewayJob.started_at ?? null,
      status: "succeeded",
      tenant_id: event.data.tenant_id
    };

    const [{ error: extractionError }, { error: artifactError }] = await Promise.all([
      supabase.from("document_extractions").upsert(extractionRecord, { onConflict: "id" }),
      supabase.from("document_extraction_artifacts").upsert(artifactRows(terminalGatewayJob, artifacts), {
        onConflict: "extraction_id,storage_bucket,storage_path"
      })
    ]);

    if (extractionError) {
      throw extractionError;
    }

    if (artifactError) {
      throw artifactError;
    }

    await recordIndexingTransition({
      document: {
        status: "structuring",
        status_reason: "Extraccion MinerU lista; Tree Indexer pendiente"
      },
      documentId: event.data.document_id,
      event: {
        eventType: "indexing.extract.completed",
        message: "Extraccion MinerU persistida en Storage",
        metadata: {
          artifact_count: artifacts.length,
          artifact_prefix: extractionRecord.artifact_prefix,
          extraction_id: terminalGatewayJob.job_id,
          extraction_pipeline_version: extractionPipelineVersion,
          indexing_pipeline_version: indexingPipelineVersion,
          job_id: terminalGatewayJob.job_id,
          parser_version: parserVersion
        },
        severity: "info"
      },
      progress: 35,
      run: {
        error_message: null,
        progress: 35,
        stage: "structuring",
        status: "running"
      },
      runId: event.data.run_id,
      stage: "structuring",
      status: "running",
      tenantId: event.data.tenant_id
    });
  });
}
