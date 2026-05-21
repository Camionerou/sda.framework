import { documentIndexRequested, inngest } from "@/inngest/client";

import {
  claimIndexingRun,
  loadDocumentForIndexing,
  recordDocumentUploadIncomplete,
  recordOrchestratorReceived
} from "./claim";
import { getWorkflowConcurrency } from "./helpers";
import {
  canUseComputeGateway,
  dispatchComputeGatewayJob,
  pollComputeGatewayJob,
  recordComputeGatewayDispatching,
  recordComputeGatewayJobCreated,
  recordComputeGatewayPending,
  recordMineruExtractionFailed,
  recordMineruExtractionSucceeded
} from "./mineru";
import {
  createTreeIndexerJob,
  pollTreeIndexerJob,
  recordTreeIndexerFailed,
  recordTreeIndexerJobCreated,
  recordTreeIndexerStarted,
  recordTreeIndexerSucceeded,
  recordTreeLlmMissing
} from "./tree";
import type { StepLike } from "./types";

export const processDocumentIndex = inngest.createFunction(
  {
    concurrency: {
      key: '"sda-document-indexing"',
      limit: getWorkflowConcurrency(),
      scope: "env"
    },
    id: "process-document-index",
    idempotency: "event.data.run_id",
    name: "Process Document Index",
    retries: 3,
    triggers: [documentIndexRequested]
  },
  async ({ event, runId, step }) => {
    const workflowStep = step as unknown as StepLike;
    const executionRunId = runId || event.id;
    const claim = await claimIndexingRun({ event, executionRunId, step: workflowStep });

    if (!claim.shouldProcess) {
      return {
        document_id: event.data.document_id,
        reason: claim.reason,
        run_id: event.data.run_id,
        stage: claim.stage,
        status: "skipped"
      };
    }

    await recordOrchestratorReceived({ event, executionRunId, step: workflowStep });

    const document = await loadDocumentForIndexing({ event, step: workflowStep });

    if (!document.uploaded_at) {
      await recordDocumentUploadIncomplete({ document, event, step: workflowStep });

      return {
        document_id: event.data.document_id,
        reason: "uploaded_at_missing",
        run_id: event.data.run_id,
        status: "storage_missing"
      };
    }

    if (!canUseComputeGateway()) {
      await recordComputeGatewayPending({ event, step: workflowStep });

      return {
        document_id: event.data.document_id,
        run_id: event.data.run_id,
        status: "gateway_pending"
      };
    }

    await recordComputeGatewayDispatching({ event, step: workflowStep });

    const gatewayJob = await dispatchComputeGatewayJob({
      computeJobId: claim.computeJobId,
      document,
      event,
      step: workflowStep
    });

    if (!gatewayJob) {
      return {
        document_id: event.data.document_id,
        reason: "storage_object_missing",
        run_id: event.data.run_id,
        status: "storage_missing"
      };
    }

    await recordComputeGatewayJobCreated({ event, gatewayJob, step: workflowStep });

    const terminalGatewayJob = await pollComputeGatewayJob({
      event,
      gatewayJob,
      step: workflowStep
    });

    if (terminalGatewayJob.status === "failed") {
      await recordMineruExtractionFailed({
        document,
        event,
        step: workflowStep,
        terminalGatewayJob
      });

      return {
        compute_job_id: gatewayJob.job_id,
        document_id: event.data.document_id,
        run_id: event.data.run_id,
        status: "mineru_failed"
      };
    }

    await recordMineruExtractionSucceeded({
      document,
      event,
      step: workflowStep,
      terminalGatewayJob
    });

    await recordTreeIndexerStarted({ event, step: workflowStep, terminalGatewayJob });

    const treeJob = await createTreeIndexerJob({
      document,
      event,
      step: workflowStep,
      terminalGatewayJob
    });

    await recordTreeIndexerJobCreated({
      event,
      step: workflowStep,
      terminalGatewayJob,
      treeJob
    });

    const terminalTreeJob = await pollTreeIndexerJob({
      event,
      step: workflowStep,
      terminalGatewayJob,
      treeJob
    });

    if (terminalTreeJob.status === "failed" && terminalTreeJob.stage === "llm_missing") {
      await recordTreeLlmMissing({
        event,
        step: workflowStep,
        terminalGatewayJob,
        terminalTreeJob
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
      await recordTreeIndexerFailed({
        event,
        step: workflowStep,
        terminalGatewayJob,
        terminalTreeJob
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

    await recordTreeIndexerSucceeded({
      event,
      gatewayJob,
      step: workflowStep,
      terminalGatewayJob,
      terminalTreeJob
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
