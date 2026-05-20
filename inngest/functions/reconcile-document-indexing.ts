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
  created_at: string;
  document_id: string;
  id: string;
  progress: number;
  stage: string;
  status: string;
  tenant_id: string;
};

type DispatchableRun = {
  actor_id: string;
  document_id: string;
  run_id: string;
  source: string;
  tenant_id: string;
};

function getBatchSize() {
  const value = Number(process.env.INDEXING_RECONCILER_BATCH_SIZE ?? 25);

  return Number.isInteger(value) && value > 0 ? Math.min(value, 250) : 25;
}

function getStaleQueuedMinutes() {
  const value = Number(process.env.INDEXING_RECONCILER_STALE_QUEUED_MINUTES ?? 2);

  return Number.isFinite(value) && value > 0 ? value : 2;
}

function staleQueuedCutoff() {
  return new Date(Date.now() - getStaleQueuedMinutes() * 60 * 1000).toISOString();
}

function isUniqueViolation(error: { code?: string } | null) {
  return error?.code === "23505";
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
    .select("id, document_id, tenant_id, status, stage, progress, created_at")
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
    .select("id, document_id, tenant_id, status, stage, progress, created_at")
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
    .select("id, document_id, tenant_id, status, stage, progress, created_at")
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
    .select("id, document_id, tenant_id, status, stage, progress, created_at")
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

export const reconcileDocumentIndexing = inngest.createFunction(
  {
    concurrency: {
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
    const runsToDispatch = [...autoQueuedRuns, ...staleQueuedRuns].slice(0, batchSize);

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
      dispatched: runsToDispatch.length,
      stale_queued: staleQueuedRuns.length
    };
  }
);
