import { NextResponse } from "next/server";

import {
  canDispatchInngestEvents,
  documentIndexRequested,
  inngest
} from "@/inngest/client";
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

  if (!canDispatchInngestEvents()) {
    return NextResponse.json({
      eventQueued: false,
      run,
      warning: "INNGEST_EVENT_KEY o INNGEST_DEV no estan configurados."
    });
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
  } catch (sendError) {
    return NextResponse.json({
      eventQueued: false,
      run,
      warning: sendError instanceof Error ? sendError.message : "No se pudo enviar el evento Inngest."
    });
  }

  return NextResponse.json({ eventQueued: true, run });
}
