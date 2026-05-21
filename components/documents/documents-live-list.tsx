"use client";

import { Clock, Database, FileText, HardDriveUpload } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { RealtimeStatusBadge } from "@/components/realtime/realtime-status-badge";
import {
  formatBytes,
  isPendingVisibleDocument,
  isVisibleDocument,
  type DocumentRow
} from "@/lib/documents";
import { normalizeRealtimeStatus, type RealtimeSubscriptionStatus } from "@/lib/realtime/status";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/auth/session";
import { libStatus, libStatusLabel } from "@/lib/workspace";

type DocumentsLiveListProps = {
  errorMessage?: string;
  initialDocuments: DocumentRow[];
  tenantId: string;
};

function sortDocuments(documents: DocumentRow[]) {
  return [...documents].sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );
}

function asVisibleDocument(row: unknown): DocumentRow | null {
  const document = row as DocumentRow | null;

  if (!document?.id || !isVisibleDocument(document)) {
    return null;
  }

  return document;
}

export function DocumentsLiveList({
  errorMessage,
  initialDocuments,
  tenantId
}: DocumentsLiveListProps) {
  const [liveChanges, setLiveChanges] = useState<{
    changes: Map<string, DocumentRow | null>;
    tenantId: string;
  }>(() => ({
    changes: new Map<string, DocumentRow | null>(),
    tenantId
  }));
  const [subscription, setSubscription] = useState<{
    status: RealtimeSubscriptionStatus;
    tenantId: string;
  }>(() => ({
    status: "connecting",
    tenantId
  }));
  const status = subscription.tenantId === tenantId ? subscription.status : "connecting";

  const documents = useMemo(() => {
    const byId = new Map<string, DocumentRow>();

    for (const document of initialDocuments) {
      byId.set(document.id, document);
    }

    if (liveChanges.tenantId === tenantId) {
      for (const [documentId, document] of liveChanges.changes) {
        if (document) {
          byId.set(documentId, document);
        } else {
          byId.delete(documentId);
        }
      }
    }

    return sortDocuments([...byId.values()]).slice(0, 100);
  }, [initialDocuments, liveChanges, tenantId]);

  useEffect(() => {
    const supabase = createClient();

    const upsertDocument = (row: unknown) => {
      const nextDocument = asVisibleDocument(row);

      setLiveChanges((currentState) => {
        const changes =
          currentState.tenantId === tenantId
            ? new Map(currentState.changes)
            : new Map<string, DocumentRow | null>();

        if (!nextDocument) {
          const maybeId = (row as { id?: string } | null)?.id;
          if (maybeId) {
            changes.set(maybeId, null);
          }
          return { changes, tenantId };
        }

        changes.set(nextDocument.id, nextDocument);
        return { changes, tenantId };
      });
    };

    const channel = supabase
      .channel(`tenant:${tenantId}:postgres-documents`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          filter: `tenant_id=eq.${tenantId}`,
          schema: "public",
          table: "documents"
        },
        (payload) => upsertDocument(payload.new)
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          filter: `tenant_id=eq.${tenantId}`,
          schema: "public",
          table: "documents"
        },
        (payload) => upsertDocument(payload.new)
      )
      .subscribe((nextStatus) => {
        setSubscription({
          status: normalizeRealtimeStatus(nextStatus),
          tenantId
        });
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [tenantId]);

  const stats = useMemo(
    () => ({
      indexed: documents.filter((doc) => doc.status === "indexed").length,
      pending: documents.filter(isPendingVisibleDocument).length,
      uploaded: documents.filter((doc) => doc.status === "uploaded").length
    }),
    [documents]
  );

  return (
    <div className="section-grid">
      <div className="stats-grid">
        <div className="stat">
          <div className="stat-label">Subidos</div>
          <div className="stat-value">{stats.uploaded}</div>
          <div className="stat-sub">Listos para pipeline</div>
        </div>
        <div className="stat">
          <div className="stat-label">Pendientes</div>
          <div className="stat-value">{stats.pending}</div>
          <div className="stat-sub">Upload o indexación</div>
        </div>
        <div className="stat">
          <div className="stat-label">Indexados</div>
          <div className="stat-value">{stats.indexed}</div>
          <div className="stat-sub">Disponibles en el workspace</div>
        </div>
      </div>

      <div className="glass-card">
        <div className="gc-head gc-head-row">
          <div>
            <h2 className="gc-title">Archivos del tenant</h2>
            <p className="gc-desc">Últimos 100 documentos. Hacé click para abrirlos en el workspace.</p>
          </div>
          <RealtimeStatusBadge label="DB" status={status} />
        </div>

        {errorMessage ? (
          <div className="alert alert-danger" role="alert">
            <strong>No se pudieron leer los documentos.</strong>
            <span>{errorMessage}</span>
          </div>
        ) : null}

        {documents.length === 0 ? (
          <div className="empty">
            <FileText aria-hidden="true" size={22} />
            <div>
              <strong>No hay documentos todavía.</strong>
              <p>Subí el primer archivo desde el panel lateral.</p>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="ws-table">
              <thead>
                <tr>
                  <th>Documento</th>
                  <th>Estado</th>
                  <th>Tamaño</th>
                  <th>Subido</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => {
                  const bucket = libStatus(document.status);
                  return (
                    <tr key={document.id}>
                      <td>
                        <div className="t-primary">
                          <Link href={`/app/workspace/documents/${document.id}`}>
                            {document.title ?? document.filename}
                          </Link>
                        </div>
                        <div className="t-secondary">{document.filename}</div>
                      </td>
                      <td>
                        <span className={`status status-${bucket}`}>{libStatusLabel(document.status)}</span>
                        {document.status_reason ? (
                          <div className="t-secondary">{document.status_reason}</div>
                        ) : null}
                      </td>
                      <td>{formatBytes(document.byte_size)}</td>
                      <td>{formatDateTime(document.uploaded_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="stats-grid">
        <div className="stat">
          <div className="stat-label">
            <HardDriveUpload size={12} aria-hidden="true" /> Storage
          </div>
          <div className="stat-value small">Privado</div>
          <div className="stat-sub">Bucket documents</div>
        </div>
        <div className="stat">
          <div className="stat-label">
            <Database size={12} aria-hidden="true" /> Vector
          </div>
          <div className="stat-value small">pgvector</div>
          <div className="stat-sub">Chunks jerárquicos</div>
        </div>
        <div className="stat">
          <div className="stat-label">
            <Clock size={12} aria-hidden="true" /> Ingesta
          </div>
          <div className="stat-value small">Inngest</div>
          <div className="stat-sub">Workers largos</div>
        </div>
      </div>
    </div>
  );
}
