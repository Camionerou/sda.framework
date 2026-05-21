import { FileText, Sparkles } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import type { DocumentStatus } from "@/lib/documents";
import { getClaimValue, type AppClaims } from "@/lib/session";
import { libStatus, libStatusLabel } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type HomeDocRow = {
  id: string;
  title: string | null;
  filename: string;
  status: DocumentStatus;
};

export default async function WorkspaceHome() {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    redirect("/login");
  }

  const claims = claimsData.claims as AppClaims;
  const tenantId = getClaimValue<string>(claims, "tenant_id", "tenant_id");
  if (!tenantId) {
    redirect("/app");
  }

  const { data: rows } = await supabase
    .from("documents")
    .select("id, title, filename, status")
    .order("created_at", { ascending: false })
    .limit(8)
    .returns<HomeDocRow[]>();

  const documents = rows ?? [];

  return (
    <main className="center" style={{ gridColumn: "2 / -1" }}>
      <div className="glass" style={{ flex: 1, display: "grid", placeItems: "center", padding: 32 }}>
        <div style={{ width: "min(560px, 92%)", display: "grid", gap: 20, justifyItems: "center" }}>
          <span className="ve-ico" aria-hidden="true">
            <Sparkles size={24} />
          </span>
          <div style={{ textAlign: "center", display: "grid", gap: 6 }}>
            <h1
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 24,
                fontWeight: 800,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                margin: 0
              }}
            >
              Tu memoria documental
            </h1>
            <p style={{ color: "var(--muted)", fontSize: 14, margin: 0, lineHeight: 1.5 }}>
              Elegí un documento para abrirlo en el workspace: lectura del PDF, árbol semántico
              navegable e indexación en vivo, lado a lado.
            </p>
          </div>

          {documents.length > 0 ? (
            <div className="lib" style={{ width: "100%", maxWidth: 420, overflow: "visible" }}>
              {documents.map((doc) => {
                const bucket = libStatus(doc.status);
                return (
                  <Link
                    key={doc.id}
                    href={`/app/workspace/documents/${doc.id}`}
                    className={`lib-item ${bucket === "running" ? "is-running" : ""}`}
                  >
                    <span className="thumb">
                      <span>PDF</span>
                    </span>
                    <span className="body">
                      <span className="title">{doc.title ?? doc.filename}</span>
                      <span className="meta">{doc.filename}</span>
                    </span>
                    <span className={`status status-${bucket}`}>{libStatusLabel(doc.status)}</span>
                  </Link>
                );
              })}
            </div>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              No hay documentos todavía.{" "}
              <Link href="/app/documents" style={{ color: "var(--teal-2)", fontWeight: 600 }}>
                Subí el primero
              </Link>
              .
            </p>
          )}

          <Link
            href="/app/documents"
            className="row"
            style={{ color: "var(--muted)", fontSize: 12.5 }}
          >
            <FileText size={14} aria-hidden="true" />
            Ver biblioteca completa
          </Link>
        </div>
      </div>
    </main>
  );
}
