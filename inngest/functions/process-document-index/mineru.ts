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
import { recordTransition, transitionInput } from "./transitions";
import type { DocumentForIndexing, ProcessDocumentIndexEvent, StepLike } from "./types";

export async function recordComputeGatewayPending(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
}) {
  const { event, step } = input;

  await recordTransition({
    event,
    step,
    stepId: "record-compute-gateway-pending",
    transition: "compute_gateway_pending"
  });
}

export function canUseComputeGateway() {
  return isComputeGatewayConfigured();
}

async function waitForComputeGatewayEvent(input: {
  attempt: number;
  interval: string;
  jobId: string;
  step: StepLike;
}) {
  const { attempt, interval, jobId, step } = input;

  if (!step.waitForEvent) {
    await step.sleep(`wait-compute-gateway-job-${attempt}`, interval);
    return null;
  }

  return step.waitForEvent<ComputeGatewayIndexJobStatus>(
    `wait-compute-gateway-event-${attempt}`,
    {
      event: "compute/mineru.completed",
      if: `async.data.job_id == ${JSON.stringify(jobId)}`,
      timeout: interval
    }
  );
}

export async function recordComputeGatewayDispatching(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
}) {
  const { event, step } = input;

  await recordTransition({
    event,
    extras: {
      run: {
        started_at: new Date().toISOString()
      }
    },
    step,
    stepId: "record-compute-gateway-dispatching",
    transition: "compute_gateway_dispatching"
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
        .from(document.storage_bucket)
        .createSignedUrl(document.storage_path, getSignedUrlTtlSeconds());

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
          signed_url: signedUrl.signedUrl,
          storage_bucket: document.storage_bucket,
          storage_path: document.storage_path
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
            reason: "signed_url_failed",
            storage_bucket: document.storage_bucket,
            storage_path: document.storage_path
          },
          runId: event.data.run_id,
          tenantId: event.data.tenant_id
        });
        return;
      }

      await recordIndexingTransition(
        transitionInput(event, "compute_gateway_dispatch_failed", {
          event: { message },
          run: {
            error_message: message
          }
        })
      );
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

  await recordTransition({
    event,
    extras: {
      metadata: {
        gateway_status: gatewayJob.status,
        job_id: gatewayJob.job_id
      },
      run: {
        compute_job_id: gatewayJob.job_id
      }
    },
    step,
    stepId: "record-compute-gateway-job-created",
    transition: "compute_gateway_job_created"
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
      const progress = mapGatewayProgress(currentJob);
      const stage = mapGatewayStage(currentJob);
      const message = currentJob.message ?? "Compute Gateway procesando MinerU";

      await recordTransition({
        event,
        extras: {
          document: {
            status_reason: message
          },
          event: { message },
          metadata: {
            gateway_progress: currentJob.progress,
            gateway_stage: currentJob.stage,
            gateway_status: currentJob.status,
            job_id: currentJob.job_id
          },
          progress,
          run: {
            progress,
            stage
          },
          stage
        },
        step,
        stepId: `record-compute-gateway-progress-${attempt}`,
        transition: "compute_gateway_progress"
      });
    }

    const terminalEvent = await waitForComputeGatewayEvent({
      attempt,
      interval,
      jobId: gatewayJob.job_id,
      step
    });

    if (
      terminalEvent?.data &&
      (terminalEvent.data.status === "succeeded" || terminalEvent.data.status === "failed")
    ) {
      return terminalEvent.data;
    }
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
        artifact_bucket: terminalGatewayJob.artifact_bucket ?? document.storage_bucket,
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
        source_r2_key: document.storage_path,
        status: "failed",
        tenant_id: event.data.tenant_id
      },
      { onConflict: "id" }
    );

    if (extractionError) {
      throw extractionError;
    }

    await recordIndexingTransition(
      transitionInput(event, "extract_failed", {
        document: {
          status_reason: message
        },
        event: { message },
        metadata: {
          gateway_stage: terminalGatewayJob.stage,
          gateway_status: terminalGatewayJob.status,
          job_id: terminalGatewayJob.job_id
        },
        run: {
          error_message: message,
          failed_at: new Date().toISOString()
        }
      })
    );
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
      artifact_bucket: terminalGatewayJob.artifact_bucket ?? document.storage_bucket,
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
      source_r2_key: document.storage_path,
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

    await recordIndexingTransition(
      transitionInput(event, "extract_completed", {
        metadata: {
          artifact_count: artifacts.length,
          artifact_prefix: extractionRecord.artifact_prefix,
          extraction_id: terminalGatewayJob.job_id,
          extraction_pipeline_version: extractionPipelineVersion,
          indexing_pipeline_version: indexingPipelineVersion,
          job_id: terminalGatewayJob.job_id,
          parser_version: parserVersion
        }
      })
    );
  });
}
