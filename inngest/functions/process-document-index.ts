import { documentIndexRequested, inngest } from "@/inngest/client";
import {
  createComputeGatewayIndexJob,
  createComputeGatewayTreeIndexJob,
  getComputeGatewayIndexJob,
  getComputeGatewayTreeIndexJob,
  getSignedUrlTtlSeconds,
  isComputeGatewayConfigured,
  type ComputeGatewayIndexJobResponse,
  type ComputeGatewayIndexJobStatus,
  type ComputeGatewayTreeIndexJobResponse,
  type ComputeGatewayTreeIndexJobStatus
} from "@/lib/compute-gateway";
import {
  artifactRows,
  getArtifactPrefix,
  getExtractionPipelineVersion,
  getGatewayPollAttempts,
  getGatewayPollInterval,
  getIndexingPipelineVersion,
  getParserVersion,
  getTreeIndexerPollAttempts,
  getTreeIndexerPollInterval,
  getWorkflowConcurrency,
  isStorageObjectMissingError,
  mapGatewayProgress,
  mapGatewayStage,
  mapTreeProgress,
  mapTreeStage,
  messageFromError
} from "@/inngest/functions/indexing-workflow-helpers";
import {
  recordIndexingTransition,
  recordPermanentIndexingFailure
} from "@/lib/indexing-state";
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
  compute_job_id: string | null;
  id: string;
  inngest_run_id: string | null;
  progress: number;
  stage: string;
  status: string;
};

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

      return {
        document_id: event.data.document_id,
        run_id: event.data.run_id,
        status: "gateway_pending"
      };
    }

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

    const gatewayJob = await (async (): Promise<ComputeGatewayIndexJobResponse | null> => {
      if (claim.computeJobId) {
        return {
          job_id: claim.computeJobId,
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
        const message = messageFromError(
          dispatchError,
          "No se pudo crear el job en Compute Gateway."
        );
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
    })();

    if (terminalGatewayJob.status === "failed") {
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

    await step.run("record-tree-indexer-started", async () => {
      await recordIndexingTransition({
        document: {
          status: "structuring",
          status_reason: "Tree Indexer construyendo arbol con LLM"
        },
        documentId: event.data.document_id,
        event: {
          eventType: "indexing.tree.started",
          message: "Tree Indexer Python inicio construccion PageIndex-style con LLM",
          metadata: {
            ...INDEXING_VERSION_METADATA,
            extraction_id: terminalGatewayJob.job_id,
            indexer: TREE_INDEXER_PYTHON_VERSION
          },
          severity: "info"
        },
        progress: 40,
        run: {
          error_message: null,
          progress: 40,
          stage: "structuring",
          status: "running"
        },
        runId: event.data.run_id,
        stage: "structuring",
        status: "running",
        tenantId: event.data.tenant_id
      });
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
          const message =
            dispatchError instanceof Error
              ? dispatchError.message
              : "No se pudo crear el job en Tree Indexer.";

          await recordIndexingTransition({
            document: {
              status: "structuring",
              status_reason: "Tree Indexer no recibio el job; Inngest puede reintentar"
            },
            documentId: event.data.document_id,
            event: {
              eventType: "indexing.tree.dispatch_failed",
              message,
              metadata: {
                extraction_id: terminalGatewayJob.job_id,
                retry_owner: "inngest"
              },
              severity: "error"
            },
            progress: 40,
            run: {
              error_message: message,
              progress: 40,
              stage: "structuring",
              status: "running"
            },
            runId: event.data.run_id,
            stage: "structuring",
            status: "running",
            tenantId: event.data.tenant_id
          });
        });

        throw dispatchError;
      }
    })();

    await step.run("record-tree-indexer-job-created", async () => {
      await recordIndexingTransition({
        document: {
          status: "structuring",
          status_reason: "Tree Indexer Python procesando estructura"
        },
        documentId: event.data.document_id,
        event: {
          eventType: "indexing.tree.job_created",
          message: "Tree Indexer Python recibio el job",
          metadata: {
            extraction_id: terminalGatewayJob.job_id,
            tree_job_id: treeJob.job_id,
            tree_status: treeJob.status
          },
          severity: "info"
        },
        progress: 42,
        run: {
          error_message: null,
          progress: 42,
          stage: "structuring",
          status: "running"
        },
        runId: event.data.run_id,
        stage: "structuring",
        status: "running",
        tenantId: event.data.tenant_id
      });
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
            const progress = mapTreeProgress(currentJob);
            const stage = mapTreeStage(currentJob);
            const message = currentJob.message ?? "Tree Indexer Python procesando estructura";

            await recordIndexingTransition({
              document: {
                status: "structuring",
                status_reason: message
              },
              documentId: event.data.document_id,
              event: {
                eventType: "indexing.tree.progress",
                message,
                metadata: {
                  extraction_id: terminalGatewayJob.job_id,
                  tree_job_id: currentJob.job_id,
                  tree_progress: currentJob.progress,
                  tree_stage: currentJob.stage,
                  tree_status: currentJob.status
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

        await step.sleep(`wait-tree-indexer-job-${attempt}`, interval);
      }

      throw new Error(`Tree Indexer job ${treeJob.job_id} no termino dentro del tiempo esperado.`);
    })();

    if (terminalTreeJob.status === "failed" && terminalTreeJob.stage === "llm_missing") {
      await step.run("record-tree-llm-missing", async () => {
        const message = terminalTreeJob.error ?? "Tree LLM no configurado; extraccion MinerU lista.";

        await recordIndexingTransition({
          document: {
            status: "structuring",
            status_reason: message
          },
          documentId: event.data.document_id,
          event: {
            eventType: "indexing.tree.llm_missing",
            message,
            metadata: {
              extraction_id: terminalGatewayJob.job_id,
              required_env: ["SDA_TREE_LLM_API_KEY", "SDA_TREE_LLM_MODEL"],
              tree_job_id: terminalTreeJob.job_id
            },
            severity: "warning"
          },
          progress: 35,
          releaseActiveRun: true,
          run: {
            error_message: message,
            failed_at: new Date().toISOString(),
            progress: 35,
            stage: "structuring",
            status: "failed"
          },
          runId: event.data.run_id,
          stage: "structuring",
          status: "failed",
          tenantId: event.data.tenant_id
        });
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
        const message = terminalTreeJob.error ?? "Tree Indexer fallo.";

        await recordIndexingTransition({
          document: {
            status: "failed",
            status_reason: `Tree Indexer fallo; MinerU disponible. ${message}`
          },
          documentId: event.data.document_id,
          event: {
            eventType: "indexing.tree.failed",
            message,
            metadata: {
              extraction_id: terminalGatewayJob.job_id,
              tree_job_id: terminalTreeJob.job_id,
              tree_stage: terminalTreeJob.stage
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
      const now = new Date().toISOString();

      await recordIndexingTransition({
        document: {
          embedding_pipeline_version: INDEXING_VERSION_COLUMNS.embedding_pipeline_version,
          extraction_pipeline_version: getExtractionPipelineVersion(terminalGatewayJob),
          indexed_at: now,
          indexing_pipeline_version: INDEXING_VERSION_COLUMNS.indexing_pipeline_version,
          status: "indexed",
          status_reason: "Tree Index listo; embeddings jerarquicos pendientes",
          tree_indexer_version: INDEXING_VERSION_COLUMNS.tree_indexer_version
        },
        documentId: event.data.document_id,
        event: {
          eventType: "indexing.tree.completed",
          message: "Tree Index persistido en doc_tree y chunks recuperables",
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
            tree_indexer_version: INDEXING_VERSION_COLUMNS.tree_indexer_version,
            tree_job_id: terminalTreeJob.job_id,
            version: terminalTreeJob.version
          },
          severity: "info"
        },
        progress: 100,
        releaseActiveRun: true,
        run: {
          completed_at: now,
          error_message: null,
          progress: 100,
          stage: "indexed",
          status: "completed"
        },
        runId: event.data.run_id,
        stage: "indexed",
        status: "completed",
        tenantId: event.data.tenant_id
      });
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
