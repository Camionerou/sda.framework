import {
  createComputeGatewayTreeIndexJob,
  getComputeGatewayTreeIndexJob,
  type ComputeGatewayIndexJobResponse,
  type ComputeGatewayIndexJobStatus,
  type ComputeGatewayTreeIndexJobResponse,
  type ComputeGatewayTreeIndexJobStatus
} from "@/lib/indexing/compute-gateway";
import { recordIndexingTransition } from "@/lib/indexing/state";
import {
  INDEXING_VERSION_COLUMNS,
  INDEXING_VERSION_METADATA,
  TREE_INDEXER_PYTHON_VERSION
} from "@/lib/system-versions";

import {
  getExtractionPipelineVersion,
  getTreeIndexerPollAttempts,
  getTreeIndexerPollInterval,
  mapTreeProgress,
  mapTreeStage
} from "./helpers";
import type { DocumentForIndexing, ProcessDocumentIndexEvent, StepLike } from "./types";

export async function recordTreeIndexerStarted(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
  terminalGatewayJob: ComputeGatewayIndexJobStatus;
}) {
  const { event, step, terminalGatewayJob } = input;

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
}

export async function createTreeIndexerJob(input: {
  document: DocumentForIndexing;
  event: ProcessDocumentIndexEvent;
  step: StepLike;
  terminalGatewayJob: ComputeGatewayIndexJobStatus;
}): Promise<ComputeGatewayTreeIndexJobResponse> {
  const { document, event, step, terminalGatewayJob } = input;

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
}

export async function recordTreeIndexerJobCreated(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
  terminalGatewayJob: ComputeGatewayIndexJobStatus;
  treeJob: ComputeGatewayTreeIndexJobResponse;
}) {
  const { event, step, terminalGatewayJob, treeJob } = input;

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
}

export async function pollTreeIndexerJob(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
  terminalGatewayJob: ComputeGatewayIndexJobStatus;
  treeJob: ComputeGatewayTreeIndexJobResponse;
}) {
  const { event, step, terminalGatewayJob, treeJob } = input;
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
}

export async function recordTreeLlmMissing(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
  terminalGatewayJob: ComputeGatewayIndexJobStatus;
  terminalTreeJob: ComputeGatewayTreeIndexJobStatus;
}) {
  const { event, step, terminalGatewayJob, terminalTreeJob } = input;

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
}

export async function recordTreeIndexerFailed(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
  terminalGatewayJob: ComputeGatewayIndexJobStatus;
  terminalTreeJob: ComputeGatewayTreeIndexJobStatus;
}) {
  const { event, step, terminalGatewayJob, terminalTreeJob } = input;

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
}

export async function recordTreeIndexerSucceeded(input: {
  event: ProcessDocumentIndexEvent;
  gatewayJob: ComputeGatewayIndexJobResponse;
  step: StepLike;
  terminalGatewayJob: ComputeGatewayIndexJobStatus;
  terminalTreeJob: ComputeGatewayTreeIndexJobStatus;
}) {
  const { event, step, terminalGatewayJob, terminalTreeJob } = input;

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
}
