import { recordIndexingTransition, type IndexingTransitionInput } from "@/lib/indexing/state";

import type { ProcessDocumentIndexEvent, StepLike } from "./types";

type TransitionBase = Omit<
  IndexingTransitionInput,
  "document" | "documentId" | "run" | "runId" | "tenantId"
> & {
  document?: Record<string, unknown>;
  run?: Record<string, unknown>;
};

type TransitionExtras = Partial<
  Pick<
    IndexingTransitionInput,
    "document" | "progress" | "releaseActiveRun" | "run" | "stage" | "status"
  >
> & {
  event?: Partial<IndexingTransitionInput["event"]>;
  metadata?: Record<string, unknown>;
};

export const TRANSITIONS = {
  compute_gateway_dispatching: {
    document: {
      status: "parsing",
      status_reason: "Enviando documento al Compute Gateway"
    },
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
      status: "running"
    },
    stage: "extracting",
    status: "running"
  },
  compute_gateway_dispatch_failed: {
    document: {
      status: "parsing",
      status_reason: "Compute Gateway no recibio el job; Inngest puede reintentar"
    },
    event: {
      eventType: "indexing.compute_gateway.dispatch_failed",
      message: "No se pudo crear el job en Compute Gateway.",
      metadata: {
        retry_owner: "inngest"
      },
      severity: "error"
    },
    progress: 5,
    run: {
      progress: 5,
      stage: "extracting",
      status: "running"
    },
    stage: "extracting",
    status: "running"
  },
  compute_gateway_job_created: {
    document: {
      status: "parsing",
      status_reason: "Compute Gateway ejecutando MinerU"
    },
    event: {
      eventType: "indexing.compute_gateway.job_created",
      message: "Compute Gateway recibio el job de MinerU",
      severity: "info"
    },
    progress: 8,
    run: {
      error_message: null,
      progress: 8,
      stage: "extracting",
      status: "running"
    },
    stage: "extracting",
    status: "running"
  },
  compute_gateway_pending: {
    document: {
      status_reason: "Esperando Compute Gateway"
    },
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
    stage: "queued",
    status: "queued"
  },
  compute_gateway_progress: {
    document: {
      status: "parsing",
      status_reason: "Compute Gateway procesando MinerU"
    },
    event: {
      eventType: "indexing.compute_gateway.progress",
      message: "Compute Gateway procesando MinerU",
      severity: "info"
    },
    progress: 8,
    run: {
      status: "running"
    },
    stage: "extracting",
    status: "running"
  },
  extract_completed: {
    document: {
      status: "structuring",
      status_reason: "Extraccion MinerU lista; Tree Indexer pendiente"
    },
    event: {
      eventType: "indexing.extract.completed",
      message: "Extraccion MinerU persistida en Storage",
      severity: "info"
    },
    progress: 35,
    run: {
      error_message: null,
      progress: 35,
      stage: "structuring",
      status: "running"
    },
    stage: "structuring",
    status: "running"
  },
  extract_failed: {
    document: {
      status: "failed"
    },
    event: {
      eventType: "indexing.extract.failed",
      message: "MinerU fallo en Compute Gateway.",
      severity: "error"
    },
    progress: 100,
    releaseActiveRun: true,
    run: {
      progress: 100,
      stage: "failed",
      status: "failed"
    },
    stage: "failed",
    status: "failed"
  },
  orchestrator_received: {
    event: {
      eventType: "indexing.orchestrator.received",
      message: "Inngest recibio la corrida de indexacion",
      severity: "info"
    },
    progress: 0,
    stage: "queued",
    status: "running"
  },
  orchestrator_skipped: {
    event: {
      eventType: "indexing.orchestrator.skipped",
      message: "Evento de indexacion duplicado ignorado",
      severity: "debug"
    },
    progress: 0,
    stage: "queued",
    status: "running"
  },
  tree_completed: {
    event: {
      eventType: "indexing.tree.completed",
      message: "Tree Index persistido en doc_tree y chunks recuperables",
      severity: "info"
    },
    progress: 100,
    releaseActiveRun: true,
    run: {
      error_message: null,
      progress: 100,
      stage: "indexed",
      status: "completed"
    },
    stage: "indexed",
    status: "completed"
  },
  tree_dispatch_failed: {
    document: {
      status: "structuring",
      status_reason: "Tree Indexer no recibio el job; Inngest puede reintentar"
    },
    event: {
      eventType: "indexing.tree.dispatch_failed",
      message: "No se pudo crear el job en Tree Indexer.",
      metadata: {
        retry_owner: "inngest"
      },
      severity: "error"
    },
    progress: 40,
    run: {
      progress: 40,
      stage: "structuring",
      status: "running"
    },
    stage: "structuring",
    status: "running"
  },
  tree_failed: {
    document: {
      status: "failed"
    },
    event: {
      eventType: "indexing.tree.failed",
      message: "Tree Indexer fallo.",
      severity: "error"
    },
    progress: 100,
    releaseActiveRun: true,
    run: {
      progress: 100,
      stage: "failed",
      status: "failed"
    },
    stage: "failed",
    status: "failed"
  },
  tree_job_created: {
    document: {
      status: "structuring",
      status_reason: "Tree Indexer Python procesando estructura"
    },
    event: {
      eventType: "indexing.tree.job_created",
      message: "Tree Indexer Python recibio el job",
      severity: "info"
    },
    progress: 42,
    run: {
      error_message: null,
      progress: 42,
      stage: "structuring",
      status: "running"
    },
    stage: "structuring",
    status: "running"
  },
  tree_llm_missing: {
    document: {
      status: "structuring"
    },
    event: {
      eventType: "indexing.tree.llm_missing",
      message: "Tree LLM no configurado; extraccion MinerU lista.",
      metadata: {
        required_env: ["SDA_TREE_LLM_API_KEY", "SDA_TREE_LLM_MODEL"]
      },
      severity: "warning"
    },
    progress: 35,
    releaseActiveRun: true,
    run: {
      progress: 35,
      stage: "structuring",
      status: "failed"
    },
    stage: "structuring",
    status: "failed"
  },
  tree_progress: {
    document: {
      status: "structuring",
      status_reason: "Tree Indexer Python procesando estructura"
    },
    event: {
      eventType: "indexing.tree.progress",
      message: "Tree Indexer Python procesando estructura",
      severity: "info"
    },
    progress: 42,
    run: {
      status: "running"
    },
    stage: "structuring",
    status: "running"
  },
  tree_started: {
    document: {
      status: "structuring",
      status_reason: "Tree Indexer construyendo arbol con LLM"
    },
    event: {
      eventType: "indexing.tree.started",
      message: "Tree Indexer Python inicio construccion PageIndex-style con LLM",
      severity: "info"
    },
    progress: 40,
    run: {
      error_message: null,
      progress: 40,
      stage: "structuring",
      status: "running"
    },
    stage: "structuring",
    status: "running"
  }
} as const satisfies Record<string, TransitionBase>;

export type TransitionKey = keyof typeof TRANSITIONS;

export function transitionInput(
  eventInput: ProcessDocumentIndexEvent,
  transition: TransitionKey,
  extras: TransitionExtras = {}
): IndexingTransitionInput {
  const base: TransitionBase = TRANSITIONS[transition];
  const event = {
    ...base.event,
    ...extras.event,
    metadata: {
      ...(base.event.metadata ?? {}),
      ...(extras.metadata ?? {}),
      ...(extras.event?.metadata ?? {})
    }
  };

  return {
    ...base,
    ...extras,
    document:
      base.document || extras.document
        ? {
            ...(base.document ?? {}),
            ...(extras.document ?? {})
          }
        : undefined,
    documentId: eventInput.data.document_id,
    event,
    run:
      base.run || extras.run
        ? {
            ...(base.run ?? {}),
            ...(extras.run ?? {})
          }
        : undefined,
    runId: eventInput.data.run_id,
    tenantId: eventInput.data.tenant_id
  };
}

export async function recordTransition(input: {
  event: ProcessDocumentIndexEvent;
  extras?: TransitionExtras;
  step: StepLike;
  stepId: string;
  transition: TransitionKey;
}) {
  await input.step.run(input.stepId, async () =>
    recordIndexingTransition(transitionInput(input.event, input.transition, input.extras))
  );
}
