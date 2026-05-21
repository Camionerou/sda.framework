"use client";

import { Bell, ChevronRight, PanelRight, Share2 } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  indexingStageLabel,
  type DocumentExtractionArtifactRow,
  type DocumentExtractionRow,
  type DocumentRow,
  type IndexingEventRow,
  type IndexingRunRow,
  type IndexingRunStatus
} from "@/lib/documents";
import { useDocumentExtractionsRealtime } from "@/lib/realtime/use-document-extractions-realtime";
import { useDocumentIndexingRealtime } from "@/lib/realtime/use-document-indexing-realtime";
import { useDocumentPresence } from "@/lib/realtime/use-document-presence";
import { useTenantNotifications } from "@/lib/realtime/use-tenant-notifications";
import { INDEXING_VERSION_COLUMNS } from "@/lib/system-versions";
import type { TreeRowView } from "@/lib/workspace";

import { Inspector, type InspectorTab } from "./inspector";

const PdfViewer = dynamic(() => import("./pdf-viewer").then((mod) => mod.PdfViewer), {
  loading: () => (
    <div className="stage glass-strong" style={{ gridTemplateColumns: "1fr", display: "grid" }}>
      <div className="canvas" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="viewer-empty" role="status" aria-live="polite">
          <p>Cargando documento...</p>
        </div>
      </div>
    </div>
  ),
  ssr: false
});

type DetailVersion = { label: string; component: string; value: string | null };

type WorkspaceClientProps = {
  document: DocumentRow;
  initialArtifacts: DocumentExtractionArtifactRow[];
  initialExtractions: DocumentExtractionRow[];
  tenantLabel: string;
  tenantId: string;
  treeRows: TreeRowView[];
  treeSummary: string | null;
  treeModel: string | null;
  treeVersion: string | null;
  chunksCount: number;
  initialRun: IndexingRunRow | null;
  initialEvents: IndexingEventRow[];
  versions: DetailVersion[];
  latestVersions: Record<string, string>;
  defaultTab: InspectorTab;
  viewer: {
    id: string;
    label: string;
  };
};

function initials(label: string) {
  return label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "U";
}

export function WorkspaceClient({
  document,
  initialArtifacts,
  initialExtractions,
  tenantLabel,
  tenantId,
  treeRows,
  treeSummary,
  treeModel,
  treeVersion,
  chunksCount,
  initialRun,
  initialEvents,
  versions,
  latestVersions,
  defaultTab,
  viewer
}: WorkspaceClientProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [currentPage, setCurrentPage] = useState(1);
  const [jumpTarget, setJumpTarget] = useState<{ page: number; nonce: number } | null>(null);
  const [highlightRange, setHighlightRange] = useState<{ start: number; end: number } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const nonce = useRef(0);
  const refreshOnTerminalRun = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router, startTransition]);
  const {
    events,
    realtimeStatus: indexingRealtimeStatus,
    run,
    setRun
  } = useDocumentIndexingRealtime({
    documentId: document.id,
    initialEvents,
    initialRun,
    onTerminalRun: refreshOnTerminalRun
  });
  const {
    artifacts,
    extractions,
    realtimeStatus: extractionRealtimeStatus
  } = useDocumentExtractionsRealtime({
    documentId: document.id,
    initialArtifacts,
    initialExtractions
  });
  const { presenceStatus, viewers } = useDocumentPresence({
    currentPage,
    documentId: document.id,
    label: viewer.label,
    userId: viewer.id
  });
  const { notifications } = useTenantNotifications({ tenantId });

  const onSelectNode = useCallback((row: TreeRowView) => {
    if (row.pageStart != null) {
      nonce.current += 1;
      setJumpTarget({ page: row.pageStart, nonce: nonce.current });
      setHighlightRange(row.pageEnd != null ? { start: row.pageStart, end: row.pageEnd } : null);
      return;
    }
    setHighlightRange(null);
  }, []);

  const canRequest =
    !run || run.status === "completed" || run.status === "failed" || run.status === "canceled";

  const onRequestIndex = useCallback(async () => {
    setRequestError(null);
    setRequesting(true);
    try {
      const response = await fetch(`/api/documents/${document.id}/indexing/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "workspace" })
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string;
            run?: {
              document_id: string;
              progress: number;
              run_id: string;
              stage: IndexingRunRow["stage"];
              status: IndexingRunStatus;
            };
          }
        | null;

      if (!response.ok) {
        setRequestError(payload?.error ?? "No se pudo pedir la indexación.");
        return;
      }

      const runRow = payload?.run;
      if (runRow?.run_id) {
        setRun((current) => ({
          attempt: current?.attempt ?? 1,
          completed_at: current?.completed_at ?? null,
          compute_job_id: current?.compute_job_id ?? null,
          created_at: current?.created_at ?? new Date().toISOString(),
          document_id: runRow.document_id,
          embedding_pipeline_version:
            current?.embedding_pipeline_version ??
            INDEXING_VERSION_COLUMNS.embedding_pipeline_version,
          error_message: null,
          extraction_pipeline_version:
            current?.extraction_pipeline_version ??
            INDEXING_VERSION_COLUMNS.extraction_pipeline_version,
          failed_at: null,
          id: runRow.run_id,
          inngest_run_id: current?.inngest_run_id ?? null,
          indexing_pipeline_version:
            current?.indexing_pipeline_version ??
            INDEXING_VERSION_COLUMNS.indexing_pipeline_version,
          progress: runRow.progress,
          stage: runRow.stage,
          started_at: current?.started_at ?? null,
          status: runRow.status,
          tree_indexer_version:
            current?.tree_indexer_version ?? INDEXING_VERSION_COLUMNS.tree_indexer_version
        }));
      }
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "No se pudo pedir la indexación.");
    } finally {
      setRequesting(false);
    }
  }, [document.id, setRun]);

  const live = run?.status === "running" || run?.status === "queued";
  const notificationTitle = notifications.length
    ? `${notifications.length} actualizaciones live`
    : "Notificaciones";

  return (
    <>
      <main className="center">
        <div className="glass topbar">
          <div className="crumbs">
            <Link href="/app/workspace">{tenantLabel}</Link>
            <ChevronRight size={12} aria-hidden="true" style={{ opacity: 0.5 }} />
            <Link href="/app/workspace">Documentos</Link>
            <ChevronRight size={12} aria-hidden="true" style={{ opacity: 0.5 }} />
            <span className="here">{document.title ?? document.filename}</span>
          </div>

          <div className="topbar-center">
            <span className="doc-name">{document.filename}</span>
          </div>

          <div className="topbar-actions">
            {viewers.length > 0 ? (
              <div className="presence-stack" title={`${viewers.length} usuario(s) en este documento`}>
                {viewers.slice(0, 3).map((presence) => (
                  <span className="presence-pill" key={presence.key}>
                    {initials(presence.label)}
                  </span>
                ))}
                {viewers.length > 3 ? <span className="presence-more">+{viewers.length - 3}</span> : null}
              </div>
            ) : null}
            {live ? (
              <div className="live-strip" role="status" aria-live="polite">
                <span className="ls-spin" aria-hidden="true" />
                <span>{indexingStageLabel(run!.stage)}</span>
                <span className="ls-bar" aria-hidden="true">
                  <i style={{ width: `${run!.progress}%` }} />
                </span>
                <span style={{ color: "var(--ink-2)" }}>{run!.progress}%</span>
              </div>
            ) : null}
            <button className="ico-btn" type="button" title="Compartir (próximamente)" disabled>
              <Share2 size={16} aria-hidden="true" />
            </button>
            <button
              className={`ico-btn ${notifications.length > 0 ? "has-live-dot" : ""}`}
              type="button"
              title={notificationTitle}
              aria-label={notificationTitle}
            >
              <Bell size={16} aria-hidden="true" />
            </button>
            <button
              className="ico-btn"
              type="button"
              title="Mostrar/ocultar inspector"
              aria-expanded={inspectorOpen}
              onClick={() => setInspectorOpen((v) => !v)}
            >
              <PanelRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <PdfViewer
          documentId={document.id}
          documentStatus={document.status}
          liveStage={run?.stage ?? null}
          liveProgress={run?.progress ?? null}
          currentPage={currentPage}
          onPageChange={setCurrentPage}
          jumpTarget={jumpTarget}
          highlightRange={highlightRange}
        />
      </main>

      <aside className={`glass inspector ${inspectorOpen ? "is-open" : ""}`} aria-label="Inspector del documento">
        <Inspector
          document={document}
          treeRows={treeRows}
          treeSummary={treeSummary}
          treeModel={treeModel}
          treeVersion={treeVersion}
          chunksCount={chunksCount}
          run={run}
          events={events}
          extractionArtifacts={artifacts}
          extractionRealtimeStatus={extractionRealtimeStatus}
          extractions={extractions}
          indexingRealtimeStatus={indexingRealtimeStatus}
          presenceStatus={presenceStatus}
          versions={versions}
          latestVersions={latestVersions}
          defaultTab={defaultTab}
          currentPage={currentPage}
          requesting={requesting}
          requestError={requestError}
          canRequest={canRequest}
          onSelectNode={onSelectNode}
          onRequestIndex={onRequestIndex}
        />
      </aside>
    </>
  );
}
