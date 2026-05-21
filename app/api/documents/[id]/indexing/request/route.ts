import { NextResponse } from "next/server";

import {
  canDispatchInngestEvents,
  documentIndexRequested,
  inngest
} from "@/inngest/client";
import { invalidateDocumentDetailSnapshotCache } from "@/lib/document-detail-cache";
import {
  acquireIndexingDispatchLock,
  recordIndexingApiHeartbeat,
  releaseIndexingTenantActiveRun,
  reserveIndexingTenantActiveRun,
  releaseIndexingDispatchLock
} from "@/lib/indexing-redis";
import { clientIpFromHeaders, limitIndexingRequest } from "@/lib/rate-limit";
import { getClaimValue, type AppClaims } from "@/lib/session";
import { INDEXING_VERSION_METADATA } from "@/lib/system-versions";
import { createClient } from "@/lib/supabase/server";

type IndexingRequestRow = {
  document_id: string;
  progress: number;
  run_id: string;
  stage: string;
  status: string;
};

async function readSource(request: Request) {
  try {
    const body = (await request.json()) as { source?: unknown };

    return typeof body.source === "string" && body.source.trim()
      ? body.source.trim().slice(0, 80)
      : "api";
  } catch {
    return "api";
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const source = await readSource(request);
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const claims = claimsData.claims as AppClaims;
  const actorId = getClaimValue<string>(claims, "sub");
  const tenantId = getClaimValue<string>(claims, "tenant_id", "tenant_id");

  if (!actorId || !tenantId) {
    return NextResponse.json({ error: "Tenant claim is required" }, { status: 403 });
  }

  const rateLimit = await limitIndexingRequest({
    actorId,
    ip: clientIpFromHeaders(request.headers),
    tenantId
  });

  if (!rateLimit.success) {
    return NextResponse.json(
      {
        error: "Demasiadas solicitudes de indexacion. Reintenta en unos segundos.",
        limit: rateLimit.limit,
        reset: rateLimit.reset
      },
      {
        headers: rateLimit.reset
          ? {
              "retry-after": String(Math.max(1, Math.ceil((rateLimit.reset - Date.now()) / 1000)))
            }
          : undefined,
        status: 429
      }
    );
  }

  const { data, error } = await supabase.rpc("request_document_indexing", {
    _document_id: id,
    _metadata: { ...INDEXING_VERSION_METADATA, source }
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const run = (Array.isArray(data) ? data[0] : data) as IndexingRequestRow | undefined;

  if (!run?.run_id) {
    return NextResponse.json(
      { error: "No se pudo obtener la corrida de indexacion." },
      { status: 500 }
    );
  }

  await invalidateDocumentDetailSnapshotCache({
    documentId: run.document_id,
    tenantId
  });

  if (!canDispatchInngestEvents()) {
    return NextResponse.json({
      eventQueued: false,
      run,
      warning: "INNGEST_EVENT_KEY o INNGEST_DEV no estan configurados."
    });
  }

  const dispatchLock = await acquireIndexingDispatchLock({
    documentId: run.document_id,
    runId: run.run_id,
    tenantId
  });

  if (!dispatchLock.acquired) {
    return NextResponse.json({
      deduped: true,
      eventQueued: true,
      run,
      warning: "La indexacion ya fue despachada recientemente."
    });
  }

  const tenantActiveSlot = await reserveIndexingTenantActiveRun({
    documentId: run.document_id,
    runId: run.run_id,
    tenantId
  });

  if (!tenantActiveSlot.allowed) {
    await releaseIndexingDispatchLock(dispatchLock);

    return NextResponse.json(
      {
        active_count: tenantActiveSlot.active_count,
        backpressure: true,
        error: "Hay demasiadas indexaciones activas para este tenant. Reintenta en breve.",
        limit: tenantActiveSlot.limit,
        retry_after_seconds: tenantActiveSlot.retry_after_seconds
      },
      {
        headers: tenantActiveSlot.retry_after_seconds
          ? {
              "retry-after": String(tenantActiveSlot.retry_after_seconds)
            }
          : undefined,
        status: 429
      }
    );
  }

  try {
    await inngest.send(
      documentIndexRequested.create({
        actor_id: actorId,
        document_id: run.document_id,
        run_id: run.run_id,
        source,
        tenant_id: tenantId
      })
    );
    await recordIndexingApiHeartbeat({
      active_count: tenantActiveSlot.active_count,
      document_id: run.document_id,
      rate_limit_source: rateLimit.source,
      run_id: run.run_id,
      tenant_active_limit: tenantActiveSlot.limit,
      tenant_id: tenantId
    });
  } catch (sendError) {
    await releaseIndexingDispatchLock(dispatchLock);
    await releaseIndexingTenantActiveRun({
      runId: run.run_id,
      tenantId
    });

    return NextResponse.json({
      eventQueued: false,
      run,
      warning: sendError instanceof Error ? sendError.message : "No se pudo enviar el evento Inngest."
    });
  }

  return NextResponse.json({ eventQueued: true, run });
}
