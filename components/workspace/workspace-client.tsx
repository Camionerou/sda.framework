"use client";

import { Bell, ChevronRight, PanelRight, Share2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  indexingStageLabel,
  type DocumentRow,
  type IndexingEventRow,
  type IndexingRunRow,
  type IndexingRunStatus
} from "@/lib/documents";
import { createClient } from "@/lib/supabase/client";
import { INDEXING_VERSION_COLUMNS } from "@/lib/system-versions";
import type { TreeRowView } from "@/lib/workspace";

import { Inspector, type InspectorTab } from "./inspector";
import { PdfViewer } from "./pdf-viewer";

type DetailVersion = { label: string; component: string; value: string | null };

type WorkspaceClientProps = {
  document: DocumentRow;
  tenantLabel: string;
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
};

function sortEvents(events: IndexingEventRow[]) {
  return [...events].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

export function WorkspaceClient({
  document,
  tenantLabel,
  treeRows,
  treeSummary,
  treeModel,
  treeVersion,
  chunksCount,
  initialRun,
  initialEvents,
  versions,
  latestVersions,
  defaultTab
}: WorkspaceClientProps) {
  const [run, setRun] = useState<IndexingRunRow | null>(initialRun);
  const [events, setEvents] = useState<IndexingEventRow[]>(() => sortEvents(initialEvents));
  const [currentPage, setCurrentPage] = useState(1);
  const [jumpTarget, setJumpTarget] = useState<{ page: number; nonce: number } | null>(null);
  const [highlightRange, setHighlightRange] = useState<{ start: number; end: number } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const nonce = useRef(0);

  // ---- Realtime: run + events scoped to this document ------------------
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`workspace-doc:${document.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "indexing_runs",
          filter: `document_id=eq.${document.id}`
        },
        (payload) => {
          const next = payload.new as IndexingRunRow;
          if (!next?.id) {
            return;
          }
          setRun((current) => {
            if (!current) {
              return next;
            }
            return new Date(next.created_at) >= new Date(current.created_at) ? next : current;
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "indexing_events",
          filter: `document_id=eq.${document.id}`
        },
        (payload) => {
          const next = payload.new as IndexingEventRow;
          if (!next?.id) {
            return;
          }
          setEvents((current) => {
            if (current.some((e) => e.id === next.id)) {
              return current;
            }
            return sortEvents([...current, next]).slice(-120);
          });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [document.id]);

  const onSelectNode = useCallback((row: TreeRowView) => {
    if (row.pageStart != null) {
      nonce.current += 1;
      setJumpTarget({ page: row.pageStart, nonce: nonce.current });
      if (row.pageEnd != null) {
        setHighlightRange({ start: row.pageStart, end: row.pageEnd });
      }
    }
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
    } finally {
      setRequesting(false);
    }
  }, [document.id]);

  const live = run?.status === "running" || run?.status === "queued";

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
            <button className="ico-btn" type="button" title="Compartir">
              <Share2 size={16} aria-hidden="true" />
            </button>
            <button className="ico-btn" type="button" title="Notificaciones">
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
