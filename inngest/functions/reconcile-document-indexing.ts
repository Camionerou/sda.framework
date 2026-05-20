import { cron } from "inngest";

import { documentIndexRequested, inngest } from "@/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

type UploadedDocument = {
  created_by: string | null;
  id: string;
  tenant_id: string;
  uploaded_at: string | null;
};

type ActiveRun = {
  attempt: number;
  compute_job_id: string | null;
  created_at: string;
  document_id: string;
  error_message: string | null;
  id: string;
  progress: number;
  started_at: string | null;
  stage: string;
  status: string;
  tenant_id: string;
  updated_at: string;
};

type DispatchableRun = {
  actor_id: string;
  document_id: string;
  run_id: string;
  source: string;
  tenant_id: string;
};

type ReconcilerDocument = UploadedDocument & {
  r2_bucket: string;
  r2_key: string;
  status: string;
};

type ReconcilerRepairResult = {
  completed_indexed_runs: number;
  failed_incomplete_upload_runs: number;
};

function getBatchSize() {
  const value = Number(process.env.INDEXING_RECONCILER_BATCH_SIZE ?? 25);

  return Number.isInteger(value) && value > 0 ? Math.min(value, 250) : 25;
}

function getStaleQueuedMinutes() {
  const value = Number(process.env.INDEXING_RECONCILER_STALE_QUEUED_MINUTES ?? 2);

  return Number.isFinite(value) && value > 0 ? value : 2;
}

function getStaleRunningMinutes() {
  const value = Number(process.env.INDEXING_RECONCILER_STALE_RUNNING_MINUTES ?? 60);

  return Number.isFinite(value) && value > 0 ? value : 60;
}

function staleQueuedCutoff() {
  return new Date(Date.now() - getStaleQueuedMinutes() * 60 * 1000).toISOString();
}

function staleRunningCutoff() {
  return new Date(Date.now() - getStaleRunningMinutes() * 60 * 1000).toISOString();
}

function isUniqueViolation(error: { code?: string } | null) {
  return error?.code === "23505";
}

function activeRunColumns() {
  return [
    "id",
    "document_id",
    "tenant_id",
    "status",
    "stage",
    "progress",
    "attempt",
    "compute_job_id",
    "error_message",
    "started_at",
    "created_at",
    "updated_at"
  ].join(", ");
}

async function loadActiveRuns(limit: number): Promise<ActiveRun[]> {
  if (limit <= 0) {
    return [];
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("indexing_runs")
    .select(activeRunColumns())
    .in("status", ["queued", "running"])
    .order("updated_at", { ascending: true })
    .limit(limit)
    .returns<ActiveRun[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

async function loadDocumentsForRuns(runs: ActiveRun[]): Promise<Map<string, ReconcilerDocument>> {
  if (runs.length === 0) {
    return new Map();
  }

  const supabase = createAdminClient();
  const documentIds = [...new Set(runs.map((run) => run.document_id))];
  const { data, error } = await supabase
    .from("documents")
    .select("id, tenant_id, created_by, uploaded_at, status, r2_bucket, r2_key")
    .in("id", documentIds)
    .returns<ReconcilerDocument[]>();

  if (error) {
    throw error;
  }

  return new Map((data ?? []).map((document) => [`${document.tenant_id}:${document.id}`, document]));
}

async function completeRunsWithPersistedTree(limit: number): Promise<number> {
  const runs = await loadActiveRuns(limit);

  if (runs.length === 0) {
    return 0;
  }

  const supabase = createAdminClient();
  const documentIds = [...new Set(runs.map((run) => run.document_id))];
  const [{ data: trees, error: treeError }, { data: chunks, error: chunkError }] =
    await Promise.all([
      supabase
        .from("doc_tree")
        .select("tenant_id, document_id")
        .in("document_id", documentIds)
        .returns<Array<{ document_id: string; tenant_id: string }>>(),
      supabase
        .from("chunks")
        .select("tenant_id, document_id")
        .in("document_id", documentIds)
        .limit(5000)
        .returns<Array<{ document_id: string; tenant_id: string }>>()
    ]);

  if (treeError) {
    throw treeError;
  }

  if (chunkError) {
    throw chunkError;
  }

  const treeKeys = new Set((trees ?? []).map((tree) => `${tree.tenant_id}:${tree.document_id}`));
  const chunkCounts = new Map<string, number>();

  for (const chunk of chunks ?? []) {
    const key = `${chunk.tenant_id}:${chunk.document_id}`;
    chunkCounts.set(key, (chunkCounts.get(key) ?? 0) + 1);
  }

  const completableRuns = runs.filter((run) => {
    const key = `${run.tenant_id}:${run.document_id}`;

    return treeKeys.has(key) && (chunkCounts.get(key) ?? 0) > 0;
  });

  let completed = 0;

  for (const run of completableRuns) {
    const now = new Date().toISOString();
    const key = `${run.tenant_id}:${run.document_id}`;
    const chunkCount = chunkCounts.get(key) ?? 0;
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
          .eq("id", run.id)
          .eq("tenant_id", run.tenant_id)
          .in("status", ["queued", "running"]),
        supabase
          .from("documents")
          .update({
            indexed_at: now,
            status: "indexed",
            status_reason: "Tree Index listo; embeddings jerarquicos pendientes"
          })
          .eq("id", run.document_id)
          .eq("tenant_id", run.tenant_id),
        supabase.from("indexing_events").insert({
          document_id: run.document_id,
          event_type: "indexing.reconciler.completed_from_persisted_tree",
          metadata: {
            chunk_count: chunkCount,
            previous_stage: run.stage,
            previous_status: run.status
          },
          message: "Reconciliador cerro la corrida porque el arbol y los chunks ya estaban persistidos",
          progress: 100,
          run_id: run.id,
          severity: "info",
          stage: "indexed",
          tenant_id: run.tenant_id
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

    completed += 1;
  }

  return completed;
}

async function failIncompleteUploadRuns(limit: number): Promise<number> {
  const runs = await loadActiveRuns(limit);

  if (runs.length === 0) {
    return 0;
  }

  const documents = await loadDocumentsForRuns(runs);
  const supabase = createAdminClient();
  let failed = 0;

  for (const run of runs) {
    const document = documents.get(`${run.tenant_id}:${run.document_id}`);

    if (!document || document.uploaded_at) {
      continue;
    }

    const message = "Upload incompleto: archivo no confirmado en Storage";
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
          .eq("id", run.id)
          .eq("tenant_id", run.tenant_id)
          .in("status", ["queued", "running"]),
        supabase
          .from("documents")
          .update({
            status: "failed",
            status_reason: message
          })
          .eq("id", run.document_id)
          .eq("tenant_id", run.tenant_id),
        supabase.from("indexing_events").insert({
          document_id: run.document_id,
          event_type: "indexing.storage_object_missing",
          metadata: {
            previous_document_status: document.status,
            previous_run_stage: run.stage,
            r2_bucket: document.r2_bucket,
            r2_key: document.r2_key,
            reason: "uploaded_at_missing"
          },
          message,
          progress: 100,
          run_id: run.id,
          severity: "error",
          stage: "failed",
          tenant_id: run.tenant_id
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

    failed += 1;
  }

  return failed;
}

async function loadUploadedDocumentsWithoutActiveRun(limit: number): Promise<UploadedDocument[]> {
  const supabase = createAdminClient();
  const { data: documents, error: documentError } = await supabase
    .from("documents")
    .select("id, tenant_id, created_by, uploaded_at")
    .eq("status", "uploaded")
    .not("uploaded_at", "is", null)
    .order("uploaded_at", { ascending: true })
    .limit(limit)
    .returns<UploadedDocument[]>();

  if (documentError) {
    throw documentError;
  }

  if (!documents?.length) {
    return [];
  }

  const documentIds = documents.map((document) => document.id);
  const { data: activeRuns, error: runsError } = await supabase
    .from("indexing_runs")
    .select(activeRunColumns())
    .in("document_id", documentIds)
    .in("status", ["queued", "running"])
    .returns<ActiveRun[]>();

  if (runsError) {
    throw runsError;
  }

  const activeKeys = new Set(
    (activeRuns ?? []).map((run) => `${run.tenant_id}:${run.document_id}`)
  );

  return documents.filter((document) => !activeKeys.has(`${document.tenant_id}:${document.id}`));
}

async function findActiveRun(document: UploadedDocument): Promise<ActiveRun | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("indexing_runs")
    .select(activeRunColumns())
    .eq("tenant_id", document.tenant_id)
    .eq("document_id", document.id)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<ActiveRun>();

  if (error) {
    throw error;
  }

  return data ?? null;
}

async function queueDocument(document: UploadedDocument): Promise<DispatchableRun | null> {
  const supabase = createAdminClient();
  const metadata = {
    automated: true,
    source: "inngest_reconciler"
  };
  const { data: run, error: insertError } = await supabase
    .from("indexing_runs")
    .insert({
      document_id: document.id,
      metadata,
      progress: 0,
      stage: "queued",
      status: "queued",
      tenant_id: document.tenant_id
    })
    .select(activeRunColumns())
    .maybeSingle<ActiveRun>();

  if (insertError && isUniqueViolation(insertError)) {
    const existingRun = await findActiveRun(document);

    return existingRun
      ? {
          actor_id: document.created_by ?? "system",
          document_id: existingRun.document_id,
          run_id: existingRun.id,
          source: "inngest_reconciler_existing_active_run",
          tenant_id: existingRun.tenant_id
        }
      : null;
  }

  if (insertError) {
    throw insertError;
  }

  if (!run) {
    return null;
  }

  const [{ error: eventError }, { error: documentError }] = await Promise.all([
    supabase.from("indexing_events").insert({
      document_id: document.id,
      event_type: "indexing.run.auto_queued",
      metadata,
      message: "Documento en cola automaticamente por reconciliador",
      progress: 0,
      run_id: run.id,
      severity: "info",
      stage: "queued",
      tenant_id: document.tenant_id
    }),
    supabase
      .from("documents")
      .update({
        status: "queued",
        status_reason: "Indexacion en cola automatica"
      })
      .eq("id", document.id)
      .eq("tenant_id", document.tenant_id)
  ]);

  if (eventError) {
    throw eventError;
  }

  if (documentError) {
    throw documentError;
  }

  return {
    actor_id: document.created_by ?? "system",
    document_id: run.document_id,
    run_id: run.id,
    source: "inngest_reconciler_auto_queue",
    tenant_id: run.tenant_id
  };
}

async function loadStaleQueuedRuns(limit: number): Promise<DispatchableRun[]> {
  if (limit <= 0) {
    return [];
  }

  const supabase = createAdminClient();
  const { data: runs, error: runsError } = await supabase
    .from("indexing_runs")
    .select(activeRunColumns())
    .eq("status", "queued")
    .eq("stage", "queued")
    .lte("created_at", staleQueuedCutoff())
    .order("created_at", { ascending: true })
    .limit(limit)
    .returns<ActiveRun[]>();

  if (runsError) {
    throw runsError;
  }

  if (!runs?.length) {
    return [];
  }

  const documentIds = [...new Set(runs.map((run) => run.document_id))];
  const { data: documents, error: documentsError } = await supabase
    .from("documents")
    .select("id, tenant_id, created_by")
    .in("id", documentIds)
    .returns<Array<Pick<UploadedDocument, "created_by" | "id" | "tenant_id">>>();

  if (documentsError) {
    throw documentsError;
  }

  const documentMap = new Map(
    (documents ?? []).map((document) => [`${document.tenant_id}:${document.id}`, document])
  );

  return runs.map((run) => {
    const document = documentMap.get(`${run.tenant_id}:${run.document_id}`);

    return {
      actor_id: document?.created_by ?? "system",
      document_id: run.document_id,
      run_id: run.id,
      source: "inngest_reconciler_stale_queued_run",
      tenant_id: run.tenant_id
    };
  });
}

async function loadStaleRunningRuns(limit: number): Promise<DispatchableRun[]> {
  if (limit <= 0) {
    return [];
  }

  const supabase = createAdminClient();
  const { data: runs, error: runsError } = await supabase
    .from("indexing_runs")
    .select(activeRunColumns())
    .eq("status", "running")
    .lte("updated_at", staleRunningCutoff())
    .order("updated_at", { ascending: true })
    .limit(limit)
    .returns<ActiveRun[]>();

  if (runsError) {
    throw runsError;
  }

  if (!runs?.length) {
    return [];
  }

  const documents = await loadDocumentsForRuns(runs);
  const dispatchableRuns: DispatchableRun[] = [];

  for (const run of runs) {
    const document = documents.get(`${run.tenant_id}:${run.document_id}`);

    if (!document?.uploaded_at) {
      continue;
    }

    const { error: runError } = await supabase
      .from("indexing_runs")
      .update({
        attempt: run.attempt + 1,
        compute_job_id: null,
        error_message: null,
        progress: 0,
        stage: "queued",
        status: "queued"
      })
      .eq("id", run.id)
      .eq("tenant_id", run.tenant_id)
      .eq("status", "running");

    if (runError) {
      throw runError;
    }

    const { error: eventError } = await supabase.from("indexing_events").insert({
      document_id: run.document_id,
      event_type: "indexing.run.requeued",
      metadata: {
        previous_compute_job_id: run.compute_job_id,
        previous_error_message: run.error_message,
        previous_stage: run.stage,
        stale_running_minutes: getStaleRunningMinutes()
      },
      message: "Reconciliador reencolo una corrida running sin progreso reciente",
      progress: 0,
      run_id: run.id,
      severity: "warning",
      stage: "queued",
      tenant_id: run.tenant_id
    });

    if (eventError) {
      throw eventError;
    }

    dispatchableRuns.push({
      actor_id: document.created_by ?? "system",
      document_id: run.document_id,
      run_id: run.id,
      source: "inngest_reconciler_stale_running_run",
      tenant_id: run.tenant_id
    });
  }

  return dispatchableRuns;
}

export const reconcileDocumentIndexing = inngest.createFunction(
  {
    concurrency: {
      key: '"sda-indexing-reconciler"',
      limit: 1,
      scope: "env"
    },
    id: "reconcile-document-indexing",
    name: "Reconcile Document Indexing",
    retries: 2,
    triggers: [cron(process.env.INDEXING_RECONCILER_CRON ?? "*/2 * * * *")]
  },
  async ({ step }) => {
    const batchSize = getBatchSize();
    const repairedRuns = await step.run("repair-active-runs", async (): Promise<ReconcilerRepairResult> => {
      const completedCount = await completeRunsWithPersistedTree(batchSize);
      const failedCount = await failIncompleteUploadRuns(batchSize);

      return {
        completed_indexed_runs: completedCount,
        failed_incomplete_upload_runs: failedCount
      };
    });

    const autoQueuedRuns = await step.run("queue-uploaded-documents-without-active-run", async () => {
      const documents = await loadUploadedDocumentsWithoutActiveRun(batchSize);
      const runs: DispatchableRun[] = [];

      for (const document of documents) {
        const run = await queueDocument(document);

        if (run) {
          runs.push(run);
        }
      }

      return runs;
    });

    const staleQueuedRuns = await step.run("load-stale-queued-runs", async () =>
      loadStaleQueuedRuns(Math.max(batchSize - autoQueuedRuns.length, 0))
    );
    const staleRunningRuns = await step.run("load-stale-running-runs", async () =>
      loadStaleRunningRuns(Math.max(batchSize - autoQueuedRuns.length - staleQueuedRuns.length, 0))
    );
    const runsToDispatch = [...autoQueuedRuns, ...staleQueuedRuns, ...staleRunningRuns].slice(
      0,
      batchSize
    );

    if (runsToDispatch.length > 0) {
      await step.sendEvent(
        "dispatch-document-index-requested-events",
        runsToDispatch.map((run) =>
          documentIndexRequested.create({
            actor_id: run.actor_id,
            document_id: run.document_id,
            run_id: run.run_id,
            source: run.source,
            tenant_id: run.tenant_id
          })
        )
      );
    }

    return {
      auto_queued: autoQueuedRuns.length,
      batch_size: batchSize,
      completed_indexed_runs: repairedRuns.completed_indexed_runs,
      dispatched: runsToDispatch.length,
      failed_incomplete_upload_runs: repairedRuns.failed_incomplete_upload_runs,
      stale_running: staleRunningRuns.length,
      stale_queued: staleQueuedRuns.length
    };
  }
);
