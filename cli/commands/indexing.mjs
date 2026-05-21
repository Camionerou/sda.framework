import { confirm, isCancel } from "@clack/prompts";
import { defineCommand } from "citty";
import { readFileSync } from "node:fs";

import { loadSdaEnv } from "../shared/env.mjs";
import { createAdminClient } from "../shared/supabase.mjs";
import { formatAge, truncate } from "../shared/output.mjs";
import { runInherited } from "../shared/process.mjs";

const healthCommand = defineCommand({
  meta: {
    name: "health",
    alias: "h",
    description: "Alias de indexing health"
  },
  args: {
    "no-cache": {
      type: "boolean",
      description: "Recalcula health en vivo sin materialized view"
    },
    "refresh-cache": {
      type: "boolean",
      description: "Refresca indexing_health_snapshot antes de leer"
    },
    strict: {
      type: "boolean",
      description: "Falla si hay condiciones estrictas incumplidas"
    }
  },
  async run({ args }) {
    const scriptArgs = ["scripts/health/indexing-health.mjs"];

    if (args["no-cache"]) {
      scriptArgs.push("--no-cache");
    }
    if (args["refresh-cache"]) {
      scriptArgs.push("--refresh-cache");
    }
    if (args.strict) {
      scriptArgs.push("--strict");
    }

    await runInherited("node", scriptArgs);
  }
});

const listCommand = defineCommand({
  meta: {
    name: "list",
    alias: ["ls", "l"],
    description: "Lista ultimas corridas"
  },
  args: {
    failed: {
      type: "boolean",
      alias: "f",
      description: "Solo corridas fallidas"
    },
    limit: {
      type: "string",
      alias: "n",
      description: "Cantidad de corridas",
      default: "20"
    }
  },
  async run({ args }) {
    loadSdaEnv();
    const supabase = createAdminClient();
    let query = supabase
      .from("indexing_runs")
      .select("id, tenant_id, document_id, status, stage, progress, created_at, updated_at, error_message")
      .order("created_at", { ascending: false })
      .limit(positiveInt(args.limit, 20));

    if (args.failed) {
      query = query.eq("status", "failed");
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    printRuns(data ?? []);
  }
});

const requeueCommand = defineCommand({
  meta: {
    name: "requeue",
    alias: ["rq", "q"],
    description: "Crea nuevas corridas y las despacha a Inngest"
  },
  args: {
    documentId: {
      type: "positional",
      description: "Document ID"
    },
    "all-failed": {
      type: "boolean",
      alias: "a",
      description: "Requeue de todos los documentos failed"
    },
    "actor-id": {
      type: "string",
      description: "Actor ID para el evento Inngest",
      default: "sda-cli"
    },
    source: {
      type: "string",
      description: "Fuente registrada en metadata",
      default: "sda-cli"
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "No pedir confirmacion"
    }
  },
  async run({ args }) {
    loadSdaEnv();

    if (!args.documentId && !args["all-failed"]) {
      throw new Error("Pasá <document-id> o --all-failed.");
    }

    const supabase = createAdminClient();
    const documents = args["all-failed"]
      ? await failedDocuments(supabase)
      : await documentsById(supabase, [args.documentId]);

    if (documents.length === 0) {
      console.log("No hay documentos para requeue.");
      return;
    }

    if (!args.yes) {
      const accepted = await confirm({
        message: `Crear y despachar ${documents.length} corrida(s)?`,
        initialValue: false
      });

      if (isCancel(accepted) || !accepted) {
        console.log("Cancelado.");
        return;
      }
    }

    for (const document of documents) {
      const run = await createQueuedRun(supabase, document, {
        actorId: args["actor-id"],
        source: args.source
      });
      await dispatchRun(run, {
        actorId: args["actor-id"],
        source: args.source
      });
      console.log(`${document.id}: queued run ${run.run_id}`);
    }
  }
});

const cancelCommand = defineCommand({
  meta: {
    name: "cancel",
    alias: "c",
    description: "Cancela una corrida activa"
  },
  args: {
    runId: {
      type: "positional",
      required: true,
      description: "Run ID"
    }
  },
  async run({ args }) {
    loadSdaEnv();
    const supabase = createAdminClient();
    const { data: run, error: readError } = await supabase
      .from("indexing_runs")
      .select("id, tenant_id, document_id, status")
      .eq("id", args.runId)
      .maybeSingle();

    if (readError) {
      throw readError;
    }

    if (!run) {
      throw new Error("Run no encontrado.");
    }

    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("indexing_runs")
      .update({
        error_message: "Cancelado desde sda CLI",
        failed_at: now,
        progress: 100,
        stage: "canceled",
        status: "canceled"
      })
      .eq("id", run.id);

    if (updateError) {
      throw updateError;
    }

    await supabase.from("indexing_events").insert({
      document_id: run.document_id,
      event_type: "indexing.run.canceled",
      message: "Corrida cancelada desde sda CLI",
      metadata: { source: "sda-cli" },
      progress: 100,
      run_id: run.id,
      severity: "warning",
      stage: "canceled",
      tenant_id: run.tenant_id
    });

    console.log(`Canceled ${run.id}`);
  }
});

const tailCommand = defineCommand({
  meta: {
    name: "tail",
    alias: "t",
    description: "Sigue eventos de un documento"
  },
  args: {
    documentId: {
      type: "positional",
      required: true,
      description: "Document ID"
    },
    interval: {
      type: "string",
      description: "Intervalo en ms",
      default: "2000"
    }
  },
  async run({ args }) {
    loadSdaEnv();
    const supabase = createAdminClient();
    const seen = new Set();
    const intervalMs = positiveInt(args.interval, 2_000);
    const documentId = await resolveTailDocumentId(supabase, args.documentId);

    console.log(`Tail indexing events for ${documentId}. Ctrl-C para salir.`);

    while (true) {
      const { data, error } = await supabase
        .from("indexing_events")
        .select("id, event_type, stage, message, progress, severity, created_at")
        .eq("document_id", documentId)
        .order("created_at", { ascending: true })
        .limit(100);

      if (error) {
        throw error;
      }

      for (const event of data ?? []) {
        if (seen.has(event.id)) {
          continue;
        }

        seen.add(event.id);
        console.log(
          `${event.stage.padEnd(14)} ${String(event.progress ?? "-").padStart(3)}% ${event.event_type.padEnd(36)} ${event.message}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
});

async function failedDocuments(supabase) {
  const { data, error } = await supabase
    .from("documents")
    .select("id, tenant_id, filename, uploaded_at, r2_bucket, r2_key")
    .eq("status", "failed")
    .not("uploaded_at", "is", null)
    .limit(100);

  if (error) {
    throw error;
  }

  return data ?? [];
}

async function resolveTailDocumentId(supabase, documentId) {
  if (documentId !== "latest") {
    return documentId;
  }

  const { data, error } = await supabase
    .from("indexing_runs")
    .select("document_id")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data?.document_id) {
    throw new Error("No hay runs para tail latest.");
  }

  return data.document_id;
}

async function documentsById(supabase, ids) {
  const { data, error } = await supabase
    .from("documents")
    .select("id, tenant_id, filename, uploaded_at, r2_bucket, r2_key")
    .in("id", ids);

  if (error) {
    throw error;
  }

  return data ?? [];
}

async function createQueuedRun(supabase, document, input) {
  if (!document.uploaded_at || !document.r2_bucket || !document.r2_key) {
    throw new Error(`${document.id}: documento sin upload/storage completo.`);
  }

  const versions = indexingVersionMetadata();

  await supabase
    .from("indexing_runs")
    .update({
      error_message: "Requeued desde sda CLI",
      failed_at: new Date().toISOString(),
      stage: "failed",
      status: "failed"
    })
    .eq("tenant_id", document.tenant_id)
    .eq("document_id", document.id)
    .in("status", ["queued", "running"]);

  const { data: run, error: runError } = await supabase
    .from("indexing_runs")
    .insert({
      document_id: document.id,
      embedding_pipeline_version: versions.embedding_pipeline_version,
      extraction_pipeline_version: versions.extraction_pipeline_version,
      indexing_pipeline_version: versions.indexing_pipeline_version,
      metadata: {
        requested_by: input.actorId,
        source: input.source,
        versions
      },
      progress: 0,
      stage: "queued",
      status: "queued",
      tenant_id: document.tenant_id,
      tree_indexer_version: versions.tree_indexer_version
    })
    .select("id, tenant_id, document_id")
    .single();

  if (runError) {
    throw runError;
  }

  const { error: eventError } = await supabase.from("indexing_events").insert({
    document_id: document.id,
    event_type: "indexing.run.queued",
    message: "Documento en cola para indexacion",
    metadata: {
      requested_by: input.actorId,
      source: input.source,
      versions
    },
    progress: 0,
    run_id: run.id,
    severity: "info",
    stage: "queued",
    tenant_id: document.tenant_id
  });

  if (eventError) {
    throw eventError;
  }

  const { error: documentError } = await supabase
    .from("documents")
    .update({
      status: "queued",
      status_reason: "Indexacion en cola"
    })
    .eq("id", document.id)
    .eq("tenant_id", document.tenant_id);

  if (documentError) {
    throw documentError;
  }

  return {
    document_id: document.id,
    run_id: run.id,
    tenant_id: document.tenant_id
  };
}

async function dispatchRun(run, input) {
  const key = process.env.INNGEST_EVENT_KEY?.trim();

  if (!key) {
    console.warn("INNGEST_EVENT_KEY no configurada; run creado pero no despachado.");
    return;
  }

  const response = await fetch(`https://inn.gs/e/${key}`, {
    body: JSON.stringify({
      data: {
        actor_id: input.actorId,
        document_id: run.document_id,
        run_id: run.run_id,
        source: input.source,
        tenant_id: run.tenant_id
      },
      name: "document/index.requested"
    }),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Inngest rechazo el evento con HTTP ${response.status}.`);
  }
}

function indexingVersionMetadata() {
  const versions = JSON.parse(readFileSync("lib/system-versions.json", "utf8"));

  return {
    app_version: versions.app,
    compute_gateway_extraction_version: versions.compute_gateway_extraction,
    embedding_pipeline_version: versions.embedding_pipeline,
    extraction_pipeline_version: versions.extraction_pipeline,
    indexing_pipeline_version: versions.indexing_pipeline,
    inngest_indexing_workflow_version: versions.inngest_indexing_workflow,
    tree_indexer_runtime_version: `sda-pageindex-python-langgraph-v${versions.tree_indexer_python}`,
    tree_indexer_version: versions.tree_indexer_python,
    tree_prompt_version: versions.tree_prompt
  };
}

function printRuns(runs) {
  for (const run of runs) {
    console.log(
      [
        truncate(run.id, 10).padEnd(11),
        truncate(run.document_id, 10).padEnd(11),
        run.status.padEnd(9),
        run.stage.padEnd(14),
        `${run.progress}%`.padStart(5),
        formatAge(run.updated_at).padStart(5),
        run.error_message ? truncate(run.error_message, 48) : ""
      ].join(" ")
    );
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const indexingCommand = defineCommand({
  meta: {
    name: "indexing",
    alias: ["i", "idx"],
    description: "Operaciones sobre corridas de indexacion"
  },
  subCommands: {
    cancel: cancelCommand,
    health: healthCommand,
    list: listCommand,
    requeue: requeueCommand,
    tail: tailCommand
  }
});
