import { NextResponse } from "next/server";

import { requireSameOrigin } from "@/lib/auth/csrf";
import { getClaimValue, type AppClaims } from "@/lib/auth/session";
import {
  dispatchIndexingRun,
  enforceIndexingRateLimit,
  isIndexingRouteResult,
  readIndexingSource,
  requestIndexingRun
} from "@/lib/indexing/request";
import { createClient } from "@/lib/supabase/server";

function jsonResult(result: {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  status?: number;
}) {
  return NextResponse.json(result.body, {
    headers: result.headers,
    status: result.status
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const csrf = requireSameOrigin(request);

  if (!csrf.ok) {
    return NextResponse.json({ error: csrf.error }, { status: csrf.status });
  }

  const { id } = await params;
  const source = await readIndexingSource(request);
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

  const rateLimitResult = await enforceIndexingRateLimit({
    actorId,
    headers: request.headers,
    tenantId
  });

  if (isIndexingRouteResult(rateLimitResult)) {
    return jsonResult(rateLimitResult);
  }

  const runResult = await requestIndexingRun({
    documentId: id,
    source,
    supabase,
    tenantId
  });

  if (isIndexingRouteResult(runResult)) {
    return jsonResult(runResult);
  }

  return jsonResult(
    await dispatchIndexingRun({
      actor: { actorId, tenantId },
      rateLimit: rateLimitResult.rateLimit,
      run: runResult.run,
      source
    })
  );
}
