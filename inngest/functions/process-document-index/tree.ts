import {
  createComputeGatewayTreeIndexJob,
  getComputeGatewayTreeIndexJob,
  type ComputeGatewayIndexJobResponse,
  type ComputeGatewayIndexJobStatus,
  type ComputeGatewayTreeIndexJobResponse,
  type ComputeGatewayTreeIndexJobStatus
} from "@/lib/indexing/compute-gateway";
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
import { recordTransition } from "./transitions";
import type { DocumentForIndexing, ProcessDocumentIndexEvent, StepLike } from "./types";

async function waitForTreeIndexerEvent(input: {
  attempt: number;
  interval: string;
  jobId: string;
  step: StepLike;
}) {
  const { attempt, interval, jobId, step } = input;

  if (!step.waitForEvent) {
    await step.sleep(`wait-tree-indexer-job-${attempt}`, interval);
    return null;
  }

  return step.waitForEvent<ComputeGatewayTreeIndexJobStatus>(
    `wait-tree-indexer-event-${attempt}`,
    {
      event: "compute/tree.completed",
      if: `async.data.job_id == ${JSON.stringify(jobId)}`,
      timeout: interval
    }
  );
}

export async function recordTreeIndexerStarted(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
  terminalGatewayJob: ComputeGatewayIndexJobStatus;
}) {
  const { event, step, terminalGatewayJob } = input;

  await recordTransition({
    event,
    extras: {
      metadata: {
        ...INDEXING_VERSION_METADATA,
        extraction_id: terminalGatewayJob.job_id,
        indexer: TREE_INDEXER_PYTHON_VERSION
      }
    },
    step,
    stepId: "record-tree-indexer-started",
    transition: "tree_started"
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
    const message =
      dispatchError instanceof Error
        ? dispatchError.message
        : "No se pudo crear el job en Tree Indexer.";

    await recordTransition({
      event,
      extras: {
        event: { message },
        metadata: {
          extraction_id: terminalGatewayJob.job_id
        },
        run: {
          error_message: message
        }
      },
      step,
      stepId: "record-tree-indexer-dispatch-failed",
      transition: "tree_dispatch_failed"
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

  await recordTransition({
    event,
    extras: {
      metadata: {
        extraction_id: terminalGatewayJob.job_id,
        tree_job_id: treeJob.job_id,
        tree_status: treeJob.status
      }
    },
    step,
    stepId: "record-tree-indexer-job-created",
    transition: "tree_job_created"
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
      const progress = mapTreeProgress(currentJob);
      const stage = mapTreeStage(currentJob);
      const message = currentJob.message ?? "Tree Indexer Python procesando estructura";

      await recordTransition({
        event,
        extras: {
          document: {
            status_reason: message
          },
          event: { message },
          metadata: {
            extraction_id: terminalGatewayJob.job_id,
            tree_job_id: currentJob.job_id,
            tree_progress: currentJob.progress,
            tree_stage: currentJob.stage,
            tree_status: currentJob.status
          },
          progress,
          run: {
            progress,
            stage
          },
          stage
        },
        step,
        stepId: `record-tree-indexer-progress-${attempt}`,
        transition: "tree_progress"
      });
    }

    const terminalEvent = await waitForTreeIndexerEvent({
      attempt,
      interval,
      jobId: treeJob.job_id,
      step
    });

    if (
      terminalEvent?.data &&
      (terminalEvent.data.status === "succeeded" || terminalEvent.data.status === "failed")
    ) {
      return terminalEvent.data;
    }
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

  const message = terminalTreeJob.error ?? "Tree LLM no configurado; extraccion MinerU lista.";

  await recordTransition({
    event,
    extras: {
      document: {
        status_reason: message
      },
      event: { message },
      metadata: {
        extraction_id: terminalGatewayJob.job_id,
        tree_job_id: terminalTreeJob.job_id
      },
      run: {
        error_message: message,
        failed_at: new Date().toISOString()
      }
    },
    step,
    stepId: "record-tree-llm-missing",
    transition: "tree_llm_missing"
  });
}

export async function recordTreeIndexerFailed(input: {
  event: ProcessDocumentIndexEvent;
  step: StepLike;
  terminalGatewayJob: ComputeGatewayIndexJobStatus;
  terminalTreeJob: ComputeGatewayTreeIndexJobStatus;
}) {
  const { event, step, terminalGatewayJob, terminalTreeJob } = input;

  const message = terminalTreeJob.error ?? "Tree Indexer fallo.";

  await recordTransition({
    event,
    extras: {
      document: {
        status_reason: `Tree Indexer fallo; MinerU disponible. ${message}`
      },
      event: { message },
      metadata: {
        extraction_id: terminalGatewayJob.job_id,
        tree_job_id: terminalTreeJob.job_id,
        tree_stage: terminalTreeJob.stage
      },
      run: {
        error_message: message,
        failed_at: new Date().toISOString()
      }
    },
    step,
    stepId: "record-tree-indexer-failed",
    transition: "tree_failed"
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

  const now = new Date().toISOString();

  await recordTransition({
    event,
    extras: {
      document: {
        embedding_pipeline_version: INDEXING_VERSION_COLUMNS.embedding_pipeline_version,
        extraction_pipeline_version: getExtractionPipelineVersion(terminalGatewayJob),
        indexed_at: now,
        indexing_pipeline_version: INDEXING_VERSION_COLUMNS.indexing_pipeline_version,
        status: "indexed",
        status_reason: "Tree Index y embeddings jerarquicos listos",
        tree_indexer_version: INDEXING_VERSION_COLUMNS.tree_indexer_version
      },
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
        document_type: terminalTreeJob.document_type,
        embedding_count: terminalTreeJob.embedding_count,
        embedding_model: terminalTreeJob.embedding_model,
        tree_indexer_version: INDEXING_VERSION_COLUMNS.tree_indexer_version,
        tree_job_id: terminalTreeJob.job_id,
        version: terminalTreeJob.version
      },
      run: {
        completed_at: now
      }
    },
    step,
    stepId: "record-tree-indexer-succeeded",
    transition: "tree_completed"
  });
}
