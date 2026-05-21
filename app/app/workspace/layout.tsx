import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { Rail, type WorkspaceDocSummary } from "@/components/workspace/rail";
import { visibleDocumentStatuses, type DocumentStatus } from "@/lib/documents";
import { getClaimValue, type AppClaims } from "@/lib/auth/session";
import { libStatus } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type RailDocRow = {
  id: string;
  title: string | null;
  filename: string;
  status: DocumentStatus;
  uploaded_at: string | null;
  created_at: string;
};

function relativeSince(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) {
    return null;
  }
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `hace ${days} d`;
  return new Date(value).toLocaleDateString("es-AR", { day: "numeric", month: "short" });
}

export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    redirect("/login");
  }

  const claims = claimsData.claims as AppClaims;
  const tenantId = getClaimValue<string>(claims, "tenant_id", "tenant_id");
  const tenantSlug = getClaimValue<string>(claims, "tenant_slug", "tenant_slug");
  const email = claims.email ?? "";

  if (!tenantId) {
    redirect("/app");
  }

  const { data: rows } = await supabase
    .from("documents")
    .select("id, title, filename, status, uploaded_at, created_at")
    .in("status", [...visibleDocumentStatuses])
    .not("uploaded_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(100)
    .returns<RailDocRow[]>();

  const documents: WorkspaceDocSummary[] = (rows ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    filename: row.filename,
    status: row.status,
    pageHint: null,
    since: relativeSince(row.uploaded_at ?? row.created_at)
  }));

  const hasActiveRun = documents.some((doc) => {
    const bucket = libStatus(doc.status);
    return bucket === "running" || bucket === "queued";
  });

  const initialsSource = tenantSlug || email || "SDA";
  const tenantInitials = initialsSource.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "SD";

  return (
    <div className="ws">
      <div className="ws-shell">
        <Rail documents={documents} tenantInitials={tenantInitials} hasActiveRun={hasActiveRun} />
        {children}
      </div>
    </div>
  );
}
