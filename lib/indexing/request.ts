import type { SupabaseClient } from "@supabase/supabase-js";

import {
  canDispatchInngestEvents,
  documentIndexRequested,
  inngest
} from "@/inngest/client";
import { deleteDocumentDetailSnapshotCache } from "@/lib/documents/detail-cache";
import { revalidateDocumentDetailSnapshotCache } from "@/lib/documents/detail";
import {
  acquireIndexingDispatchLock,
  recordIndexingApiHeartbeat,
  releaseIndexingDispatchLock,
  releaseIndexingTenantActiveRun,
  reserveIndexingTenantActiveRun
} from "@/lib/indexing/redis";
import { clientIpFromHeaders, limitIndexingRequest } from "@/lib/redis/rate-limit";
import type { Database } from "@/lib/supabase/types.gen";
import { INDEXING_VERSION_METADATA } from "@/lib/system-versions";

export type IndexingRequestRun = {
  document_id: string;
  progress: number;
  run_id: string;
  stage: string;
  status: string;
};

export type IndexingRequestActor = {
  actorId: string;
  tenantId: string;
};

export type IndexingRouteResult = {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  status?: number;
};

export async function readIndexingSource(request: Request) {
  try {
    const body = (await request.json()) as { source?: unknown };

    return typeof body.source === "string" && body.source.trim()
      ? body.source.trim().slice(0, 80)
      : "api";
  } catch {
    return "api";
  }
}

export async function enforceIndexingRateLimit(input: {
  actorId: string;
  headers: Headers;
  tenantId: string;
}): Promise<IndexingRouteResult | { rateLimit: Awaited<ReturnType<typeof limitIndexingRequest>> }> {
  const rateLimit = await limitIndexingRequest({
    actorId: input.actorId,
    ip: clientIpFromHeaders(input.headers),
    tenantId: input.tenantId
  });

  if (rateLimit.success) {
    return { rateLimit };
  }

  return {
    body: {
      error: "Demasiadas solicitudes de indexacion. Reintenta en unos segundos.",
      limit: rateLimit.limit,
      reset: rateLimit.reset
    },
    headers: rateLimit.reset
      ? {
          "retry-after": String(Math.max(1, Math.ceil((rateLimit.reset - Date.now()) / 1000)))
        }
      : undefined,
    status: 429
  };
}

export async function requestIndexingRun(input: {
  documentId: string;
  source: string;
  supabase: SupabaseClient<Database>;
  tenantId: string;
}): Promise<IndexingRouteResult | { run: IndexingRequestRun }> {
  const { data, error } = await input.supabase.rpc("request_document_indexing", {
    _document_id: input.documentId,
    _metadata: { ...INDEXING_VERSION_METADATA, source: input.source }
  });

  if (error) {
    return {
      body: { error: error.message },
      status: 400
    };
  }

  const run = (Array.isArray(data) ? data[0] : data) as IndexingRequestRun | undefined;

  if (!run?.run_id) {
    return {
      body: { error: "No se pudo obtener la corrida de indexacion." },
      status: 500
    };
  }

  revalidateDocumentDetailSnapshotCache();
  await deleteDocumentDetailSnapshotCache({
    documentId: run.document_id,
    tenantId: input.tenantId
  });

  return { run };
}

export async function dispatchIndexingRun(input: {
  actor: IndexingRequestActor;
  rateLimit: Awaited<ReturnType<typeof limitIndexingRequest>>;
  run: IndexingRequestRun;
  source: string;
}): Promise<IndexingRouteResult> {
  const { actor, rateLimit, run, source } = input;

  if (!canDispatchInngestEvents()) {
    return {
      body: {
        eventQueued: false,
        run,
        warning: "INNGEST_EVENT_KEY o INNGEST_DEV no estan configurados."
      }
    };
  }

  const dispatchLock = await acquireIndexingDispatchLock({
    documentId: run.document_id,
    runId: run.run_id,
    tenantId: actor.tenantId
  });

  if (!dispatchLock.acquired) {
    return {
      body: {
        deduped: true,
        eventQueued: true,
        run,
        warning: "La indexacion ya fue despachada recientemente."
      }
    };
  }

  const tenantActiveSlot = await reserveIndexingTenantActiveRun({
    documentId: run.document_id,
    runId: run.run_id,
    tenantId: actor.tenantId
  });

  if (!tenantActiveSlot.allowed) {
    await releaseIndexingDispatchLock(dispatchLock);

    return {
      body: {
        active_count: tenantActiveSlot.active_count,
        backpressure: true,
        error: "Hay demasiadas indexaciones activas para este tenant. Reintenta en breve.",
        limit: tenantActiveSlot.limit,
        retry_after_seconds: tenantActiveSlot.retry_after_seconds
      },
      headers: tenantActiveSlot.retry_after_seconds
        ? {
            "retry-after": String(tenantActiveSlot.retry_after_seconds)
          }
        : undefined,
      status: 429
    };
  }

  try {
    await deleteDocumentDetailSnapshotCache({
      documentId: run.document_id,
      tenantId: actor.tenantId
    });
    await inngest.send(
      documentIndexRequested.create(
        {
          actor_id: actor.actorId,
          document_id: run.document_id,
          run_id: run.run_id,
          source,
          tenant_id: actor.tenantId
        },
        {
          id: `document-index:${run.run_id}`
        }
      )
    );
    await recordIndexingApiHeartbeat({
      active_count: tenantActiveSlot.active_count,
      document_id: run.document_id,
      rate_limit_source: rateLimit.source,
      run_id: run.run_id,
      tenant_active_limit: tenantActiveSlot.limit,
      tenant_id: actor.tenantId
    });
  } catch (sendError) {
    await releaseIndexingDispatchLock(dispatchLock);
    await releaseIndexingTenantActiveRun({
      runId: run.run_id,
      tenantId: actor.tenantId
    });

    return {
      body: {
        eventQueued: false,
        run,
        warning: sendError instanceof Error
          ? sendError.message
          : "No se pudo enviar el evento Inngest."
      }
    };
  }

  return {
    body: {
      eventQueued: true,
      run
    }
  };
}

export function isIndexingRouteResult(
  value: IndexingRouteResult | { rateLimit: Awaited<ReturnType<typeof limitIndexingRequest>> } | { run: IndexingRequestRun }
): value is IndexingRouteResult {
  return "body" in value;
}
