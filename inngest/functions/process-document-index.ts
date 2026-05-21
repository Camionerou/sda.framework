import { documentIndexRequested, inngest } from "@/inngest/client";
import {
  createComputeGatewayIndexJob,
  createComputeGatewayTreeIndexJob,
  getComputeGatewayIndexJob,
  getComputeGatewayTreeIndexJob,
  getSignedUrlTtlSeconds,
  isComputeGatewayConfigured,
  type ComputeGatewayArtifact,
  type ComputeGatewayIndexJobResponse,
  type ComputeGatewayIndexJobStatus,
  type ComputeGatewayTreeIndexJobResponse,
  type ComputeGatewayTreeIndexJobStatus
} from "@/lib/compute-gateway";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  INDEXING_VERSION_COLUMNS,
  INDEXING_VERSION_METADATA,
  SYSTEM_COMPONENT_VERSIONS,
  TREE_INDEXER_PYTHON_VERSION
} from "@/lib/system-versions";

type DocumentForIndexing = {
  byte_size: number | null;
  checksum_sha256: string | null;
  filename: string;
  id: string;
  mime_type: string;
  r2_bucket: string;
  r2_key: string;
  status: string;
  tenant_id: string;
  title: string | null;
  uploaded_at: string | null;
};

type IndexingRunClaim = {
  id: string;
  inngest_run_id: string | null;
  progress: number;
  stage: string;
  status: string;
};

function getWorkflowConcurrency() {
  const value = Number(process.env.INDEXING_WORKFLOW_CONCURRENCY ?? 2);

  return Number.isInteger(value) && value > 0 ? value : 2;
}

function getGatewayPollAttempts() {
  const value = Number(process.env.COMPUTE_GATEWAY_POLL_ATTEMPTS ?? 240);

  return Number.isInteger(value) && value > 0 ? value : 240;
}

function getGatewayPollInterval() {
  return process.env.COMPUTE_GATEWAY_POLL_INTERVAL ?? "30s";
}

function getTreeIndexerPollAttempts() {
  const value = Number(process.env.TREE_INDEXER_POLL_ATTEMPTS ?? 240);

  return Number.isInteger(value) && value > 0 ? value : 240;
}

function getTreeIndexerPollInterval() {
  return process.env.TREE_INDEXER_POLL_INTERVAL ?? "30s";
}

function mapGatewayProgress(job: ComputeGatewayIndexJobStatus) {
  const gatewayProgress = Number.isFinite(job.progress) ? job.progress : 0;

  return Math.max(8, Math.min(35, 8 + Math.round(gatewayProgress * 0.27)));
}

function mapGatewayStage(job: ComputeGatewayIndexJobStatus) {
  if (job.status === "failed") {
    return "failed";
  }

  if (job.stage === "persisting_artifacts") {
    return "persisting";
  }

  return "extracting";
}

function mapTreeProgress(job: ComputeGatewayTreeIndexJobStatus) {
  const treeProgress = Number.isFinite(job.progress) ? job.progress : 0;

  return Math.max(35, Math.min(95, 35 + Math.round(treeProgress * 0.6)));
}

function mapTreeStage(job: ComputeGatewayTreeIndexJobStatus) {
  if (job.status === "failed") {
    return job.stage === "llm_missing" ? "structuring" : "failed";
  }

  if (job.status === "succeeded") {
    return "indexed";
  }

  return "structuring";
}

function getParserVersion(job: ComputeGatewayIndexJobStatus) {
  const manifestVersion = job.manifest?.parser_version;

  if (typeof job.mineru_version === "string" && job.mineru_version) {
    return job.mineru_version;
  }

  if (typeof manifestVersion === "string" && manifestVersion) {
    return manifestVersion;
  }

  return "unknown";
}

function getManifestString(
  manifest: Record<string, unknown> | undefined,
  key: string,
  fallback: string
) {
  const value = manifest?.[key];

  return typeof value === "string" && value ? value : fallback;
}

function getExtractionPipelineVersion(job: ComputeGatewayIndexJobStatus) {
  return getManifestString(
    job.manifest,
    "extraction_pipeline_version",
    INDEXING_VERSION_COLUMNS.extraction_pipeline_version
  );
}

function getIndexingPipelineVersion(job: ComputeGatewayIndexJobStatus) {
  return getManifestString(
    job.manifest,
    "indexing_pipeline_version",
    INDEXING_VERSION_COLUMNS.indexing_pipeline_version
  );
}

function getArtifactPrefix(
  job: ComputeGatewayIndexJobStatus,
  document: DocumentForIndexing,
  parserVersion: string
) {
  return (
    job.artifact_prefix ??
    [
      document.tenant_id,
      document.id,
      "extractions",
      "mineru",
      parserVersion,
      job.job_id
    ].join("/")
  );
}

function artifactRows(
  job: ComputeGatewayIndexJobStatus,
  artifacts: ComputeGatewayArtifact[]
) {
  return artifacts.map((artifact) => ({
    artifact_type: artifact.artifact_type,
    byte_size: artifact.byte_size,
    checksum_sha256: artifact.checksum_sha256,
    content_type: artifact.content_type,
    document_id: job.document_id,
    extraction_id: job.job_id,
    metadata: {
      relative_path: artifact.relative_path
    },
    storage_bucket: artifact.storage_bucket,
    storage_path: artifact.storage_path,
    tenant_id: job.tenant_id
  }));
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isStorageObjectMissingError(error: unknown) {
  const message = messageFromError(error, "").toLowerCase();

  return message.includes("object not found") || message.includes("storage object not found");
}

async function recordPermanentIndexingFailure(input: {
  documentId: string;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  progress?: number;
  runId: string;
  tenantId: string;
}) {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const progress = input.progress ?? 100;
  const [{ error: runError }, { error: documentError }, { error: eventError }] =
    await Promise.all([
      supabase
        .from("indexing_runs")
        .update({
          error_message: input.message,
          failed_at: now,
          progress,
          stage: "failed",
          status: "failed"
        })
        .eq("id", input.runId)
        .eq("tenant_id", input.tenantId),
      supabase
        .from("documents")
        .update({
          status: "failed",
          status_reason: input.message
        })
        .eq("id", input.documentId)
        .eq("tenant_id", input.tenantId),
      supabase.from("indexing_events").insert({
        document_id: input.documentId,
        event_type: input.eventType,
        metadata: input.metadata ?? {},
        message: input.message,
        progress,
        run_id: input.runId,
        severity: "error",
        stage: "failed",
        tenant_id: input.tenantId
      })
    ]);

  if (runError) {
    throw runError;
  }

  if (documentError) {
    throw documentError;
  }

  if (eventError) {
    throw eventError;
  }
}

export const processDocumentIndex = inngest.createFunction(
  {
    concurrency: {
      key: '"sda-document-indexing"',
      limit: getWorkflowConcurrency(),
      scope: "env"
    },
    id: "process-document-index",
    name: "Process Document Index",
    retries: 3,
    triggers: [documentIndexRequested]
  },
  async ({ event, runId, step }) => {
    const executionRunId = runId || event.id;
    const claim = await step.run("claim-indexing-run", async () => {
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
        .select("id, inngest_run_id, progress, stage, status")
        .maybeSingle<IndexingRunClaim>();

      if (claimError) {
        throw claimError;
      }

      if (claimed) {
        return {
          progress: claimed.progress,
          reason: "claimed",
          shouldProcess: true,
          stage: claimed.stage,
          status: claimed.status
        };
      }

      const { data: existing, error: existingError } = await supabase
        .from("indexing_runs")
        .select("id, inngest_run_id, progress, stage, status")
        .eq("id", event.data.run_id)
        .eq("tenant_id", event.data.tenant_id)
        .maybeSingle<IndexingRunClaim>();

      if (existingError) {
        throw existingError;
      }

      if (existing?.status === "running" && existing.inngest_run_id === executionRunId) {
        return {
          progress: existing.progress,
          reason: "retry_same_event",
          shouldProcess: true,
          stage: existing.stage,
          status: existing.status
        };
      }

      if (existing) {
        await supabase.from("indexing_events").insert({
          document_id: event.data.document_id,
          event_type: "indexing.orchestrator.skipped",
          metadata: {
            current_inngest_event_id: existing.inngest_run_id,
            incoming_inngest_event_id: executionRunId,
            reason: "run_already_claimed_or_terminal",
            source: event.data.source
          },
          message: "Evento de indexacion duplicado ignorado",
          progress: existing.progress,
          run_id: event.data.run_id,
          severity: "debug",
          stage: existing.stage,
          tenant_id: event.data.tenant_id
        });
      }

      return {
        progress: existing?.progress ?? 0,
        reason: existing ? "already_claimed_or_terminal" : "run_not_found",
        shouldProcess: false,
        stage: existing?.stage ?? "missing",
        status: existing?.status ?? "missing"
      };
    });

    if (!claim.shouldProcess) {
      return {
        document_id: event.data.document_id,
        reason: claim.reason,
        run_id: event.data.run_id,
        stage: claim.stage,
        status: "skipped"
      };
    }

    await step.run("record-orchestrator-received", async () => {
      const supabase = createAdminClient();
      const { error } = await supabase.from("indexing_events").insert({
        document_id: event.data.document_id,
        event_type: "indexing.orchestrator.received",
        metadata: {
          ...INDEXING_VERSION_METADATA,
          actor_id: event.data.actor_id,
          inngest_event_id: event.id,
          inngest_run_id: executionRunId,
          source: event.data.source
        },
        message: "Inngest recibio la corrida de indexacion",
        progress: 0,
        run_id: event.data.run_id,
        severity: "info",
        stage: "queued",
        tenant_id: event.data.tenant_id
      });

      if (error) {
        throw error;
      }
    });

    const document = await step.run("load-document-for-indexing", async () => {
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

    if (!document.uploaded_at) {
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

      return {
        document_id: event.data.document_id,
        reason: "uploaded_at_missing",
        run_id: event.data.run_id,
        status: "storage_missing"
      };
    }

    if (!isComputeGatewayConfigured()) {
      await step.run("record-compute-gateway-pending", async () => {
        const supabase = createAdminClient();
        const [{ error: runError }, { error: eventError }, { error: documentError }] = await Promise.all([
          supabase
            .from("indexing_runs")
            .update({
              error_message: "Esperando Compute Gateway",
              progress: 0,
              stage: "queued",
              status: "queued"
            })
            .eq("id", event.data.run_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase.from("indexing_events").insert({
            document_id: event.data.document_id,
            event_type: "indexing.compute_gateway.pending",
            metadata: {
              expected_worker: "mineru",
              host: "srv-ia-01"
            },
            message: "Esperando Compute Gateway para ejecutar MinerU",
            progress: 0,
            run_id: event.data.run_id,
            severity: "info",
            stage: "queued",
            tenant_id: event.data.tenant_id
          }),
          supabase
            .from("documents")
            .update({
              status_reason: "Esperando Compute Gateway"
            })
            .eq("id", event.data.document_id)
            .eq("tenant_id", event.data.tenant_id)
        ]);

        if (runError) {
          throw runError;
        }

        if (eventError) {
          throw eventError;
        }

        if (documentError) {
          throw documentError;
        }
      });

      return {
        document_id: event.data.document_id,
        run_id: event.data.run_id,
        status: "gateway_pending"
      };
    }

    await step.run("record-compute-gateway-dispatching", async () => {
      const supabase = createAdminClient();
      const now = new Date().toISOString();
      const [{ error: runError }, { error: documentError }, { error: eventError }] =
        await Promise.all([
          supabase
            .from("indexing_runs")
            .update({
              error_message: null,
              progress: 5,
              stage: "extracting",
              started_at: now,
              status: "running"
            })
            .eq("id", event.data.run_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase
            .from("documents")
            .update({
              status: "parsing",
              status_reason: "Enviando documento al Compute Gateway"
            })
            .eq("id", event.data.document_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase.from("indexing_events").insert({
            document_id: event.data.document_id,
            event_type: "indexing.compute_gateway.dispatching",
            metadata: {
              expected_worker: "mineru",
              host: "srv-ia-01"
            },
            message: "Enviando documento al Compute Gateway",
            progress: 5,
            run_id: event.data.run_id,
            severity: "info",
            stage: "extracting",
            tenant_id: event.data.tenant_id
          })
        ]);

      if (runError) {
        throw runError;
      }

      if (documentError) {
        throw documentError;
      }

      if (eventError) {
        throw eventError;
      }
    });

    const gatewayJob = await (async (): Promise<ComputeGatewayIndexJobResponse | null> => {
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
        const message = messageFromError(
          dispatchError,
          "No se pudo crear el job en Compute Gateway."
        );
        const storageObjectMissing = isStorageObjectMissingError(dispatchError);

        await step.run("record-compute-gateway-dispatch-failed", async () => {
          const supabase = createAdminClient();
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

          const [{ error: runError }, { error: documentError }, { error: eventError }] =
            await Promise.all([
              supabase
                .from("indexing_runs")
                .update({
                  error_message: message,
                  progress: 5,
                  stage: "extracting",
                  status: "running"
                })
                .eq("id", event.data.run_id)
                .eq("tenant_id", event.data.tenant_id),
              supabase
                .from("documents")
                .update({
                  status: "parsing",
                  status_reason: "Compute Gateway no recibio el job; Inngest puede reintentar"
                })
                .eq("id", event.data.document_id)
                .eq("tenant_id", event.data.tenant_id),
              supabase.from("indexing_events").insert({
                document_id: event.data.document_id,
                event_type: "indexing.compute_gateway.dispatch_failed",
                metadata: {
                  retry_owner: "inngest"
                },
                message,
                progress: 5,
                run_id: event.data.run_id,
                severity: "error",
                stage: "extracting",
                tenant_id: event.data.tenant_id
              })
            ]);

          if (runError) {
            throw runError;
          }

          if (documentError) {
            throw documentError;
          }

          if (eventError) {
            throw eventError;
          }
        });

        if (storageObjectMissing) {
          return null;
        }

        throw dispatchError;
      }
    })();

    if (!gatewayJob) {
      return {
        document_id: event.data.document_id,
        reason: "storage_object_missing",
        run_id: event.data.run_id,
        status: "storage_missing"
      };
    }

    await step.run("record-compute-gateway-job-created", async () => {
      const supabase = createAdminClient();
      const [{ error: runError }, { error: documentError }, { error: eventError }] =
        await Promise.all([
          supabase
            .from("indexing_runs")
            .update({
              compute_job_id: gatewayJob.job_id,
              error_message: null,
              progress: 8,
              stage: "extracting",
              status: "running"
            })
            .eq("id", event.data.run_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase
            .from("documents")
            .update({
              status: "parsing",
              status_reason: "Compute Gateway ejecutando MinerU"
            })
            .eq("id", event.data.document_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase.from("indexing_events").insert({
            document_id: event.data.document_id,
            event_type: "indexing.compute_gateway.job_created",
            metadata: {
              gateway_status: gatewayJob.status,
              job_id: gatewayJob.job_id
            },
            message: "Compute Gateway recibio el job de MinerU",
            progress: 8,
            run_id: event.data.run_id,
            severity: "info",
            stage: "extracting",
            tenant_id: event.data.tenant_id
          })
        ]);

      if (runError) {
        throw runError;
      }

      if (documentError) {
        throw documentError;
      }

      if (eventError) {
        throw eventError;
      }
    });

    const terminalGatewayJob = await (async (): Promise<ComputeGatewayIndexJobStatus> => {
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
            const supabase = createAdminClient();
            const progress = mapGatewayProgress(currentJob);
            const stage = mapGatewayStage(currentJob);
            const [{ error: runError }, { error: documentError }, { error: eventError }] =
              await Promise.all([
                supabase
                  .from("indexing_runs")
                  .update({
                    progress,
                    stage,
                    status: "running"
                  })
                  .eq("id", event.data.run_id)
                  .eq("tenant_id", event.data.tenant_id),
                supabase
                  .from("documents")
                  .update({
                    status: stage === "persisting" ? "parsing" : "parsing",
                    status_reason: currentJob.message ?? "Compute Gateway procesando MinerU"
                  })
                  .eq("id", event.data.document_id)
                  .eq("tenant_id", event.data.tenant_id),
                supabase.from("indexing_events").insert({
                  document_id: event.data.document_id,
                  event_type: "indexing.compute_gateway.progress",
                  metadata: {
                    gateway_progress: currentJob.progress,
                    gateway_stage: currentJob.stage,
                    gateway_status: currentJob.status,
                    job_id: currentJob.job_id
                  },
                  message: currentJob.message ?? "Compute Gateway procesando MinerU",
                  progress,
                  run_id: event.data.run_id,
                  severity: "info",
                  stage,
                  tenant_id: event.data.tenant_id
                })
              ]);

            if (runError) {
              throw runError;
            }

            if (documentError) {
              throw documentError;
            }

            if (eventError) {
              throw eventError;
            }
          });
        }

        await step.sleep(`wait-compute-gateway-job-${attempt}`, interval);
      }

      throw new Error(`Compute Gateway job ${gatewayJob.job_id} no termino dentro del tiempo esperado.`);
    })();

    if (terminalGatewayJob.status === "failed") {
      await step.run("record-mineru-extraction-failed", async () => {
        const supabase = createAdminClient();
        const parserVersion = getParserVersion(terminalGatewayJob);
        const message = terminalGatewayJob.error ?? "MinerU fallo en Compute Gateway.";
        const [{ error: extractionError }, { error: runError }, { error: documentError }, { error: eventError }] =
          await Promise.all([
            supabase.from("document_extractions").upsert(
              {
                artifact_bucket: terminalGatewayJob.artifact_bucket ?? document.r2_bucket,
                artifact_prefix: getArtifactPrefix(terminalGatewayJob, document, parserVersion),
                document_id: event.data.document_id,
              error_message: message,
              extraction_pipeline_version: INDEXING_VERSION_COLUMNS.extraction_pipeline_version,
              indexing_pipeline_version: INDEXING_VERSION_COLUMNS.indexing_pipeline_version,
              failed_at: terminalGatewayJob.failed_at ?? new Date().toISOString(),
                id: terminalGatewayJob.job_id,
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
            ),
            supabase
              .from("indexing_runs")
              .update({
                error_message: message,
                failed_at: new Date().toISOString(),
                progress: 100,
                stage: "failed",
                status: "failed"
              })
              .eq("id", event.data.run_id)
              .eq("tenant_id", event.data.tenant_id),
            supabase
              .from("documents")
              .update({
                status: "failed",
                status_reason: message
              })
              .eq("id", event.data.document_id)
              .eq("tenant_id", event.data.tenant_id),
            supabase.from("indexing_events").insert({
              document_id: event.data.document_id,
              event_type: "indexing.extract.failed",
              metadata: {
                gateway_stage: terminalGatewayJob.stage,
                gateway_status: terminalGatewayJob.status,
                job_id: terminalGatewayJob.job_id
              },
              message,
              progress: 100,
              run_id: event.data.run_id,
              severity: "error",
              stage: "failed",
              tenant_id: event.data.tenant_id
            })
          ]);

        if (extractionError) {
          throw extractionError;
        }

        if (runError) {
          throw runError;
        }

        if (documentError) {
          throw documentError;
        }

        if (eventError) {
          throw eventError;
        }
      });

      return {
        compute_job_id: gatewayJob.job_id,
        document_id: event.data.document_id,
        run_id: event.data.run_id,
        status: "mineru_failed"
      };
    }

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
          compute_gateway_extraction_version:
            SYSTEM_COMPONENT_VERSIONS.compute_gateway_extraction,
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
        supabase
          .from("document_extraction_artifacts")
          .upsert(artifactRows(terminalGatewayJob, artifacts), {
            onConflict: "extraction_id,storage_bucket,storage_path"
          })
      ]);

      if (extractionError) {
        throw extractionError;
      }

      if (artifactError) {
        throw artifactError;
      }

      const [{ error: runError }, { error: documentError }, { error: eventError }] =
        await Promise.all([
          supabase
            .from("indexing_runs")
            .update({
              error_message: null,
              progress: 35,
              stage: "structuring",
              status: "running"
            })
            .eq("id", event.data.run_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase
            .from("documents")
            .update({
              status: "structuring",
              status_reason: "Extraccion MinerU lista; Tree Indexer pendiente"
            })
            .eq("id", event.data.document_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase.from("indexing_events").insert({
            document_id: event.data.document_id,
            event_type: "indexing.extract.completed",
            metadata: {
              artifact_count: artifacts.length,
              artifact_prefix: extractionRecord.artifact_prefix,
              extraction_pipeline_version: extractionPipelineVersion,
              extraction_id: terminalGatewayJob.job_id,
              indexing_pipeline_version: indexingPipelineVersion,
              job_id: terminalGatewayJob.job_id,
              parser_version: parserVersion
            },
            message: "Extraccion MinerU persistida en Storage",
            progress: 35,
            run_id: event.data.run_id,
            severity: "info",
            stage: "structuring",
            tenant_id: event.data.tenant_id
          })
        ]);

      if (runError) {
        throw runError;
      }

      if (documentError) {
        throw documentError;
      }

      if (eventError) {
        throw eventError;
      }
    });

    await step.run("record-tree-indexer-started", async () => {
      const supabase = createAdminClient();
      const [{ error: runError }, { error: documentError }, { error: eventError }] =
        await Promise.all([
          supabase
            .from("indexing_runs")
            .update({
              error_message: null,
              progress: 40,
              stage: "structuring",
              status: "running"
            })
            .eq("id", event.data.run_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase
            .from("documents")
            .update({
              status: "structuring",
              status_reason: "Tree Indexer construyendo arbol con LLM"
            })
            .eq("id", event.data.document_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase.from("indexing_events").insert({
            document_id: event.data.document_id,
            event_type: "indexing.tree.started",
            metadata: {
              ...INDEXING_VERSION_METADATA,
              extraction_id: terminalGatewayJob.job_id,
              indexer: TREE_INDEXER_PYTHON_VERSION
            },
            message: "Tree Indexer Python inicio construccion PageIndex-style con LLM",
            progress: 40,
            run_id: event.data.run_id,
            severity: "info",
            stage: "structuring",
            tenant_id: event.data.tenant_id
          })
        ]);

      if (runError) {
        throw runError;
      }

      if (documentError) {
        throw documentError;
      }

      if (eventError) {
        throw eventError;
      }
    });

    const treeJob = await (async (): Promise<ComputeGatewayTreeIndexJobResponse> => {
      try {
        return await step.run("create-tree-indexer-job", async () =>
          createComputeGatewayTreeIndexJob({
            document_id: event.data.document_id,
            document_title: document.title,
            extraction_id: terminalGatewayJob.job_id,
            filename: document.filename,
            run_id: event.data.run_id,
            source: event.data.source,
            tenant_id: event.data.tenant_id,
            versions: INDEXING_VERSION_METADATA.versions
          })
        );
      } catch (dispatchError) {
        await step.run("record-tree-indexer-dispatch-failed", async () => {
          const supabase = createAdminClient();
          const message =
            dispatchError instanceof Error
              ? dispatchError.message
              : "No se pudo crear el job en Tree Indexer.";
          const [{ error: runError }, { error: documentError }, { error: eventError }] =
            await Promise.all([
              supabase
                .from("indexing_runs")
                .update({
                  error_message: message,
                  progress: 40,
                  stage: "structuring",
                  status: "running"
                })
                .eq("id", event.data.run_id)
                .eq("tenant_id", event.data.tenant_id),
              supabase
                .from("documents")
                .update({
                  status: "structuring",
                  status_reason: "Tree Indexer no recibio el job; Inngest puede reintentar"
                })
                .eq("id", event.data.document_id)
                .eq("tenant_id", event.data.tenant_id),
              supabase.from("indexing_events").insert({
                document_id: event.data.document_id,
                event_type: "indexing.tree.dispatch_failed",
                metadata: {
                  extraction_id: terminalGatewayJob.job_id,
                  retry_owner: "inngest"
                },
                message,
                progress: 40,
                run_id: event.data.run_id,
                severity: "error",
                stage: "structuring",
                tenant_id: event.data.tenant_id
              })
            ]);

          if (runError) {
            throw runError;
          }

          if (documentError) {
            throw documentError;
          }

          if (eventError) {
            throw eventError;
          }
        });

        throw dispatchError;
      }
    })();

    await step.run("record-tree-indexer-job-created", async () => {
      const supabase = createAdminClient();
      const [{ error: runError }, { error: documentError }, { error: eventError }] =
        await Promise.all([
          supabase
            .from("indexing_runs")
            .update({
              error_message: null,
              progress: 42,
              stage: "structuring",
              status: "running"
            })
            .eq("id", event.data.run_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase
            .from("documents")
            .update({
              status: "structuring",
              status_reason: "Tree Indexer Python procesando estructura"
            })
            .eq("id", event.data.document_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase.from("indexing_events").insert({
            document_id: event.data.document_id,
            event_type: "indexing.tree.job_created",
            metadata: {
              extraction_id: terminalGatewayJob.job_id,
              tree_job_id: treeJob.job_id,
              tree_status: treeJob.status
            },
            message: "Tree Indexer Python recibio el job",
            progress: 42,
            run_id: event.data.run_id,
            severity: "info",
            stage: "structuring",
            tenant_id: event.data.tenant_id
          })
        ]);

      if (runError) {
        throw runError;
      }

      if (documentError) {
        throw documentError;
      }

      if (eventError) {
        throw eventError;
      }
    });

    const terminalTreeJob = await (async (): Promise<ComputeGatewayTreeIndexJobStatus> => {
      const attempts = getTreeIndexerPollAttempts();
      const interval = getTreeIndexerPollInterval();

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const currentJob = await step.run(`poll-tree-indexer-job-${attempt}`, async () =>
          getComputeGatewayTreeIndexJob(treeJob.job_id)
        );

        if (currentJob.status === "succeeded" || currentJob.status === "failed") {
          return currentJob;
        }

        if (attempt === 1 || attempt % 4 === 0) {
          await step.run(`record-tree-indexer-progress-${attempt}`, async () => {
            const supabase = createAdminClient();
            const progress = mapTreeProgress(currentJob);
            const stage = mapTreeStage(currentJob);
            const message = currentJob.message ?? "Tree Indexer Python procesando estructura";
            const [{ error: runError }, { error: documentError }, { error: eventError }] =
              await Promise.all([
                supabase
                  .from("indexing_runs")
                  .update({
                    progress,
                    stage,
                    status: "running"
                  })
                  .eq("id", event.data.run_id)
                  .eq("tenant_id", event.data.tenant_id),
                supabase
                  .from("documents")
                  .update({
                    status: "structuring",
                    status_reason: message
                  })
                  .eq("id", event.data.document_id)
                  .eq("tenant_id", event.data.tenant_id),
                supabase.from("indexing_events").insert({
                  document_id: event.data.document_id,
                  event_type: "indexing.tree.progress",
                  metadata: {
                    extraction_id: terminalGatewayJob.job_id,
                    tree_job_id: currentJob.job_id,
                    tree_progress: currentJob.progress,
                    tree_stage: currentJob.stage,
                    tree_status: currentJob.status
                  },
                  message,
                  progress,
                  run_id: event.data.run_id,
                  severity: "info",
                  stage,
                  tenant_id: event.data.tenant_id
                })
              ]);

            if (runError) {
              throw runError;
            }

            if (documentError) {
              throw documentError;
            }

            if (eventError) {
              throw eventError;
            }
          });
        }

        await step.sleep(`wait-tree-indexer-job-${attempt}`, interval);
      }

      throw new Error(`Tree Indexer job ${treeJob.job_id} no termino dentro del tiempo esperado.`);
    })();

    if (terminalTreeJob.status === "failed" && terminalTreeJob.stage === "llm_missing") {
      await step.run("record-tree-llm-missing", async () => {
        const supabase = createAdminClient();
        const message = terminalTreeJob.error ?? "Tree LLM no configurado; extraccion MinerU lista.";
        const now = new Date().toISOString();
        const [{ error: runError }, { error: documentError }, { error: eventError }] =
          await Promise.all([
            supabase
              .from("indexing_runs")
              .update({
                error_message: message,
                failed_at: now,
                progress: 35,
                stage: "structuring",
                status: "failed"
              })
              .eq("id", event.data.run_id)
              .eq("tenant_id", event.data.tenant_id),
            supabase
              .from("documents")
              .update({
                status: "structuring",
                status_reason: message
              })
              .eq("id", event.data.document_id)
              .eq("tenant_id", event.data.tenant_id),
            supabase.from("indexing_events").insert({
              document_id: event.data.document_id,
              event_type: "indexing.tree.llm_missing",
              metadata: {
                extraction_id: terminalGatewayJob.job_id,
                required_env: ["SDA_TREE_LLM_API_KEY", "SDA_TREE_LLM_MODEL"],
                tree_job_id: terminalTreeJob.job_id
              },
              message,
              progress: 35,
              run_id: event.data.run_id,
              severity: "warning",
              stage: "structuring",
              tenant_id: event.data.tenant_id
            })
          ]);

        if (runError) {
          throw runError;
        }

        if (documentError) {
          throw documentError;
        }

        if (eventError) {
          throw eventError;
        }
      });

      return {
        compute_job_id: gatewayJob.job_id,
        document_id: event.data.document_id,
        extraction_id: terminalGatewayJob.job_id,
        run_id: event.data.run_id,
        status: "tree_llm_missing",
        tree_job_id: terminalTreeJob.job_id
      };
    }

    if (terminalTreeJob.status === "failed") {
      await step.run("record-tree-indexer-failed", async () => {
        const supabase = createAdminClient();
        const message = terminalTreeJob.error ?? "Tree Indexer fallo.";
        const now = new Date().toISOString();
        const [{ error: runError }, { error: documentError }, { error: eventError }] =
          await Promise.all([
            supabase
              .from("indexing_runs")
              .update({
                error_message: message,
                failed_at: now,
                progress: 100,
                stage: "failed",
                status: "failed"
              })
              .eq("id", event.data.run_id)
              .eq("tenant_id", event.data.tenant_id),
            supabase
              .from("documents")
              .update({
                status: "failed",
                status_reason: `Tree Indexer fallo; MinerU disponible. ${message}`
              })
              .eq("id", event.data.document_id)
              .eq("tenant_id", event.data.tenant_id),
            supabase.from("indexing_events").insert({
              document_id: event.data.document_id,
              event_type: "indexing.tree.failed",
              metadata: {
                extraction_id: terminalGatewayJob.job_id,
                tree_job_id: terminalTreeJob.job_id,
                tree_stage: terminalTreeJob.stage
              },
              message,
              progress: 100,
              run_id: event.data.run_id,
              severity: "error",
              stage: "failed",
              tenant_id: event.data.tenant_id
            })
          ]);

        if (runError) {
          throw runError;
        }

        if (documentError) {
          throw documentError;
        }

        if (eventError) {
          throw eventError;
        }
      });

      return {
        compute_job_id: gatewayJob.job_id,
        document_id: event.data.document_id,
        extraction_id: terminalGatewayJob.job_id,
        run_id: event.data.run_id,
        status: "tree_index_failed",
        tree_job_id: terminalTreeJob.job_id
      };
    }

    await step.run("record-tree-indexer-succeeded", async () => {
      const supabase = createAdminClient();
      const now = new Date().toISOString();
      const [{ error: runError }, { error: documentError }, { error: eventError }] =
        await Promise.all([
          supabase
            .from("indexing_runs")
            .update({
              completed_at: now,
              error_message: null,
              progress: 100,
              stage: "indexed",
              status: "completed"
            })
            .eq("id", event.data.run_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase
            .from("documents")
            .update({
              embedding_pipeline_version: INDEXING_VERSION_COLUMNS.embedding_pipeline_version,
              extraction_pipeline_version: getExtractionPipelineVersion(terminalGatewayJob),
              indexing_pipeline_version: INDEXING_VERSION_COLUMNS.indexing_pipeline_version,
              indexed_at: now,
              status: "indexed",
              status_reason: "Tree Index listo; embeddings jerarquicos pendientes",
              tree_indexer_version: INDEXING_VERSION_COLUMNS.tree_indexer_version
            })
            .eq("id", event.data.document_id)
            .eq("tenant_id", event.data.tenant_id),
          supabase.from("indexing_events").insert({
            document_id: event.data.document_id,
            event_type: "indexing.tree.completed",
            metadata: {
              ...INDEXING_VERSION_METADATA,
              chunk_count: terminalTreeJob.chunk_count,
              content_list_path: terminalTreeJob.content_list_path,
              extraction_id: terminalGatewayJob.job_id,
              extraction_pipeline_version: getExtractionPipelineVersion(terminalGatewayJob),
              indexing_pipeline_version: INDEXING_VERSION_COLUMNS.indexing_pipeline_version,
              model: terminalTreeJob.model,
              page_count: terminalTreeJob.page_count,
              persisted_at: terminalTreeJob.persisted_at,
              provider: terminalTreeJob.provider,
              tree_job_id: terminalTreeJob.job_id,
              tree_indexer_version: INDEXING_VERSION_COLUMNS.tree_indexer_version,
              version: terminalTreeJob.version
            },
            message: "Tree Index persistido en doc_tree y chunks recuperables",
            progress: 100,
            run_id: event.data.run_id,
            severity: "info",
            stage: "indexed",
            tenant_id: event.data.tenant_id
          })
        ]);

      if (runError) {
        throw runError;
      }

      if (documentError) {
        throw documentError;
      }

      if (eventError) {
        throw eventError;
      }
    });

    return {
      compute_job_id: gatewayJob.job_id,
      chunk_count: terminalTreeJob.chunk_count,
      document_id: event.data.document_id,
      extraction_id: terminalGatewayJob.job_id,
      run_id: event.data.run_id,
      status: "tree_indexed",
      tree_job_id: terminalTreeJob.job_id
    };
  }
);
