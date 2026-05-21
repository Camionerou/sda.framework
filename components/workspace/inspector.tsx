"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  FileText,
  History,
  Info,
  Loader2,
  Search
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  documentStatusLabel,
  formatBytes,
  indexingStageLabel,
  type DocumentExtractionArtifactRow,
  type DocumentExtractionRow,
  type DocumentRow,
  type IndexingEventRow,
  type IndexingRunRow,
  type IndexingStage
} from "@/lib/documents";
import { RealtimeStatusBadge } from "@/components/realtime/realtime-status-badge";
import { formatDateTime } from "@/lib/auth/session";
import type { RealtimeSubscriptionStatus } from "@/lib/realtime/status";
import { STAGE_PIPELINE, formatPageRange, type TreeRowView } from "@/lib/workspace";

export type InspectorTab = "structure" | "indexing" | "details";

type DetailVersion = {
  label: string;
  component: string;
  value: string | null;
};

type InspectorProps = {
  document: DocumentRow;
  treeRows: TreeRowView[];
  treeSummary: string | null;
  treeModel: string | null;
  treeVersion: string | null;
  chunksCount: number;
  run: IndexingRunRow | null;
  events: IndexingEventRow[];
  extractionArtifacts: DocumentExtractionArtifactRow[];
  extractionRealtimeStatus: RealtimeSubscriptionStatus;
  extractions: DocumentExtractionRow[];
  indexingRealtimeStatus: RealtimeSubscriptionStatus;
  presenceStatus: RealtimeSubscriptionStatus;
  versions: DetailVersion[];
  latestVersions: Record<string, string>;
  defaultTab: InspectorTab;
  currentPage: number;
  requesting: boolean;
  requestError: string | null;
  canRequest: boolean;
  onSelectNode: (row: TreeRowView) => void;
  onRequestIndex: () => void;
};

type StageState = "done" | "active" | "pending" | "error";

function railRows(run: IndexingRunRow | null): { stage: IndexingStage; state: StageState }[] {
  const completed = run?.status === "completed";
  const failed = run?.status === "failed" || run?.status === "canceled";
  const currentIndex = run ? STAGE_PIPELINE.indexOf(run.stage as IndexingStage) : -1;

  return STAGE_PIPELINE.map((stage, index) => {
    let state: StageState = "pending";
    if (completed) {
      state = "done";
    } else if (currentIndex === -1) {
      state = "pending";
    } else if (index < currentIndex) {
      state = "done";
    } else if (index === currentIndex) {
      state = failed ? "error" : "active";
    }
    return { stage, state };
  });
}

export function Inspector({
  document,
  treeRows,
  treeSummary,
  treeModel,
  treeVersion,
  chunksCount,
  run,
  events,
  extractionArtifacts,
  extractionRealtimeStatus,
  extractions,
  indexingRealtimeStatus,
  presenceStatus,
  versions,
  latestVersions,
  defaultTab,
  currentPage,
  requesting,
  requestError,
  canRequest,
  onSelectNode,
  onRequestIndex
}: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>(defaultTab);
  const [treeQuery, setTreeQuery] = useState("");

  // Active tree row = deepest node whose page range contains the current page.
  const activeKey = useMemo(() => {
    let key: string | null = null;
    for (const row of treeRows) {
      if (row.pageStart != null && row.pageEnd != null) {
        if (currentPage >= row.pageStart && currentPage <= row.pageEnd) {
          key = row.key;
        }
      }
    }
    return key;
  }, [treeRows, currentPage]);

  const visibleRows = useMemo(() => {
    const q = treeQuery.trim().toLowerCase();
    if (!q) {
      return treeRows;
    }
    return treeRows.filter((row) => row.title.toLowerCase().includes(q));
  }, [treeRows, treeQuery]);

  const stages = useMemo(() => railRows(run), [run]);

  return (
    <>
      <div className="inspector-head">
        <div className="inspector-title">
          <div className="doctype">PDF</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2>{document.title ?? document.filename}</h2>
            <div className="filemeta">
              {document.filename} · {formatBytes(document.byte_size)}
            </div>
            <div className="chips">
              <StatusChip status={document.status} run={run} />
              {treeVersion ? <span className="chip">tree {treeVersion}</span> : null}
            </div>
          </div>
        </div>

        <div className="tabs" role="tablist" aria-label="Inspector">
          <button
            className={`tab ${tab === "structure" ? "is-active" : ""}`}
            role="tab"
            aria-selected={tab === "structure"}
            type="button"
            onClick={() => setTab("structure")}
          >
            Estructura
          </button>
          <button
            className={`tab ${tab === "indexing" ? "is-active" : ""}`}
            role="tab"
            aria-selected={tab === "indexing"}
            type="button"
            onClick={() => setTab("indexing")}
          >
            Indexación
          </button>
          <button
            className={`tab ${tab === "details" ? "is-active" : ""}`}
            role="tab"
            aria-selected={tab === "details"}
            type="button"
            onClick={() => setTab("details")}
          >
            Detalles
          </button>
        </div>
      </div>

      <div className="inspector-body" role="tabpanel">
        {tab === "structure" ? (
          <StructureTab
            rows={visibleRows}
            total={treeRows.length}
            chunksCount={chunksCount}
            activeKey={activeKey}
            query={treeQuery}
            onQuery={setTreeQuery}
            onSelectNode={onSelectNode}
            onGoIndexing={() => setTab("indexing")}
          />
        ) : null}

        {tab === "indexing" ? (
          <IndexingTab
            run={run}
            events={events}
            extractionArtifacts={extractionArtifacts}
            extractionRealtimeStatus={extractionRealtimeStatus}
            extractions={extractions}
            indexingRealtimeStatus={indexingRealtimeStatus}
            presenceStatus={presenceStatus}
            stages={stages}
            requesting={requesting}
            requestError={requestError}
            canRequest={canRequest}
            onRequestIndex={onRequestIndex}
          />
        ) : null}

        {tab === "details" ? (
          <DetailsTab
            document={document}
            chunksCount={chunksCount}
            treeSummary={treeSummary}
            treeModel={treeModel}
            versions={versions}
            latestVersions={latestVersions}
          />
        ) : null}
      </div>
    </>
  );
}

function StatusChip({ status, run }: { status: DocumentRow["status"]; run: IndexingRunRow | null }) {
  if (run && (run.status === "running" || run.status === "queued")) {
    return (
      <span className="chip blue">
        <span className="dot" />
        Indexando
      </span>
    );
  }
  const tone =
    status === "indexed" ? "teal" : status === "failed" ? "danger" : status === "archived" ? "" : "amber";
  return <span className={`chip ${tone}`}>{documentStatusLabel(status)}</span>;
}

function StructureTab({
  rows,
  total,
  chunksCount,
  activeKey,
  query,
  onQuery,
  onSelectNode,
  onGoIndexing
}: {
  rows: TreeRowView[];
  total: number;
  chunksCount: number;
  activeKey: string | null;
  query: string;
  onQuery: (value: string) => void;
  onSelectNode: (row: TreeRowView) => void;
  onGoIndexing: () => void;
}) {
  if (total === 0) {
    return (
      <div className="insp-empty">
        <Search className="ie-ico" size={22} aria-hidden="true" />
        <strong>Sin índice todavía</strong>
        <p>El árbol semántico se completa cuando termina la indexación.</p>
        <button className="linklike" type="button" onClick={onGoIndexing}>
          Ver progreso de indexación →
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="insp-tools">
        <label className="search-mini">
          <Search size={12} aria-hidden="true" style={{ color: "var(--muted-2)" }} />
          <input
            type="search"
            placeholder="Buscar en el árbol…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="Buscar en el árbol"
          />
        </label>
      </div>

      <div className="tree with-lines" role="tree" aria-label="Estructura del documento">
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            className={`node depth-${row.depth} ${row.key === activeKey ? "is-active" : ""}`}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={row.key === activeKey}
            onClick={() => onSelectNode(row)}
          >
            <span className="chev" aria-hidden="true" />
            <span className="ico" aria-hidden="true">
              <FileText size={row.depth === 0 ? 12 : 11} />
            </span>
            <span className="label">{row.title}</span>
            <span className="pages">{formatPageRange(row.pageStart, row.pageEnd)}</span>
          </button>
        ))}
      </div>

      <div className="divider" />
      <span className="muted-mono">
        {total} nodos · {chunksCount} chunks
      </span>
    </>
  );
}

function IndexingTab({
  run,
  events,
  extractionArtifacts,
  extractionRealtimeStatus,
  extractions,
  indexingRealtimeStatus,
  presenceStatus,
  stages,
  requesting,
  requestError,
  canRequest,
  onRequestIndex
}: {
  run: IndexingRunRow | null;
  events: IndexingEventRow[];
  extractionArtifacts: DocumentExtractionArtifactRow[];
  extractionRealtimeStatus: RealtimeSubscriptionStatus;
  extractions: DocumentExtractionRow[];
  indexingRealtimeStatus: RealtimeSubscriptionStatus;
  presenceStatus: RealtimeSubscriptionStatus;
  stages: { stage: IndexingStage; state: StageState }[];
  requesting: boolean;
  requestError: string | null;
  canRequest: boolean;
  onRequestIndex: () => void;
}) {
  const live = run?.status === "running" || run?.status === "queued";
  const lastEvents = events.slice(-8);

  return (
    <>
      <div className="stage-progress">
        <div className="stage-head">
          <h3>{run ? indexingStageLabel(run.stage) : "Sin corrida todavía"}</h3>
          {run ? <span className="pct">{run.progress}%</span> : null}
        </div>
        {run ? (
          <>
            <div className={`stage-bar ${live ? "is-live" : ""}`}>
              <i style={{ width: `${run.progress}%` }} />
            </div>
            <div className="stage-meta">
              <span>
                {run.started_at ? `Iniciada ${formatDateTime(run.started_at)}` : "En cola"} · attempt{" "}
                {run.attempt}
              </span>
              <span>{run.status}</span>
            </div>
          </>
        ) : (
          <p style={{ color: "var(--muted)", fontSize: 12.5, margin: 0 }}>
            Poné el documento en cola para construir su memoria semántica.
          </p>
        )}
      </div>

      <div className="realtime-row" aria-label="Estado realtime">
        <RealtimeStatusBadge label="Index" status={indexingRealtimeStatus} />
        <RealtimeStatusBadge label="Extract" status={extractionRealtimeStatus} />
        <RealtimeStatusBadge label="Presence" status={presenceStatus} />
      </div>

      {run ? (
        <div className="stage-list" role="list" aria-label="Etapas de indexación">
          {stages.map(({ stage, state }) => (
            <div className={`stage-row is-${state}`} key={stage} role="listitem">
              <span className="sr-ico" aria-hidden="true">
                {state === "done" ? (
                  <CheckCircle2 size={14} />
                ) : state === "active" ? (
                  <span className="spin-mini" />
                ) : state === "error" ? (
                  <AlertTriangle size={13} />
                ) : (
                  <Circle size={12} />
                )}
              </span>
              <span className="sr-name">{indexingStageLabel(stage)}</span>
              <span className="sr-tag">
                {state === "done"
                  ? "ok"
                  : state === "active"
                    ? "···"
                    : state === "error"
                      ? "error"
                      : "pendiente"}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <ExtractionPanel artifacts={extractionArtifacts} extractions={extractions} />

      {requestError ? (
        <div className="alert alert-danger" role="alert">
          <strong>No se pudo pedir la indexación.</strong>
          <span>{requestError}</span>
        </div>
      ) : null}

      {run?.error_message ? (
        <div className="alert alert-danger" role="alert">
          <strong>La última corrida falló.</strong>
          <span>{run.error_message}</span>
        </div>
      ) : null}

      {lastEvents.length > 0 ? (
        <div>
          <div className="section-label" style={{ marginBottom: 6 }}>
            <span>Eventos</span>
            <span className="count">{events.length}</span>
          </div>
          <div className="events" role="log">
            {lastEvents.map((event) => {
              const sev = event.event_type.endsWith(".completed") ? "success" : event.severity;
              return (
                <div className={`event ev-${sev}`} key={event.id}>
                  <span className="ev-time">{shortTime(event.created_at)}</span>
                  <span className="ev-dot" aria-hidden="true" />
                  <span className="ev-msg">{event.message}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: "auto", display: "flex", gap: 8 }}>
        <button
          className="btn-primary"
          type="button"
          onClick={onRequestIndex}
          disabled={!canRequest || requesting}
        >
          {requesting ? (
            <Loader2 className="spin" size={14} aria-hidden="true" />
          ) : (
            <History size={14} aria-hidden="true" />
          )}
          {run?.status === "completed" ? "Reindexar" : "Poner en cola"}
        </button>
      </div>
    </>
  );
}

function extractionTone(status: DocumentExtractionRow["status"]) {
  if (status === "succeeded" || status === "reused") {
    return "teal";
  }

  if (status === "failed" || status === "canceled") {
    return "danger";
  }

  if (status === "running") {
    return "blue";
  }

  return "amber";
}

function shortArtifactName(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function ExtractionPanel({
  artifacts,
  extractions
}: {
  artifacts: DocumentExtractionArtifactRow[];
  extractions: DocumentExtractionRow[];
}) {
  const latest = extractions[0] ?? null;

  if (!latest && artifacts.length === 0) {
    return null;
  }

  return (
    <div className="extraction-panel">
      <div className="section-label">
        <span>Extracción</span>
        {latest ? <span className={`chip ${extractionTone(latest.status)}`}>{latest.status}</span> : null}
      </div>

      {latest ? (
        <div className="kv">
          <div className="kv-row">
            <span className="k">Parser</span>
            <span className="v mono">
              {latest.parser}@{latest.parser_version}
            </span>
          </div>
          <div className="kv-row">
            <span className="k">Backend</span>
            <span className="v mono">{latest.parser_backend}</span>
          </div>
          <div className="kv-row">
            <span className="k">Actualizado</span>
            <span className="v">{formatDateTime(latest.updated_at)}</span>
          </div>
          {latest.error_message ? (
            <div className="kv-row">
              <span className="k">Error</span>
              <span className="v">{latest.error_message}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {artifacts.length > 0 ? (
        <div className="artifact-list" aria-label="Artefactos de extracción">
          {artifacts.slice(0, 6).map((artifact) => (
            <div className="artifact-row" key={artifact.id}>
              <span className="artifact-kind">{artifact.artifact_type}</span>
              <span className="artifact-name">{shortArtifactName(artifact.storage_path)}</span>
              <span className="artifact-size">{formatBytes(artifact.byte_size)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DetailsTab({
  document,
  chunksCount,
  treeSummary,
  treeModel,
  versions,
  latestVersions
}: {
  document: DocumentRow;
  chunksCount: number;
  treeSummary: string | null;
  treeModel: string | null;
  versions: DetailVersion[];
  latestVersions: Record<string, string>;
}) {
  return (
    <>
      <div className="kv">
        <div className="kv-row">
          <span className="k">Estado</span>
          <span className="v">{documentStatusLabel(document.status)}</span>
        </div>
        <div className="kv-row">
          <span className="k">Tamaño</span>
          <span className="v">{formatBytes(document.byte_size)}</span>
        </div>
        <div className="kv-row">
          <span className="k">Tipo</span>
          <span className="v mono">{document.mime_type}</span>
        </div>
        <div className="kv-row">
          <span className="k">Chunks</span>
          <span className="v">{chunksCount}</span>
        </div>
        <div className="kv-row">
          <span className="k">Subido</span>
          <span className="v">{formatDateTime(document.uploaded_at)}</span>
        </div>
        <div className="kv-row">
          <span className="k">Indexado</span>
          <span className="v">{formatDateTime(document.indexed_at)}</span>
        </div>
        {treeModel ? (
          <div className="kv-row">
            <span className="k">Modelo</span>
            <span className="v mono">{treeModel}</span>
          </div>
        ) : null}
        {document.status_reason ? (
          <div className="kv-row">
            <span className="k">Razón</span>
            <span className="v">{document.status_reason}</span>
          </div>
        ) : null}
      </div>

      <div>
        <div className="section-label" style={{ marginBottom: 6 }}>
          <span>Versiones de pipeline</span>
        </div>
        <div className="kv">
          {versions.map((v) => {
            const latest = latestVersions[v.component];
            const tone =
              !v.value || !latest ? "" : v.value === latest ? "teal" : "amber";
            const label = !v.value || !latest ? "Sin dato" : v.value === latest ? "Actual" : "Anterior";
            return (
              <div className="kv-row" key={v.component}>
                <span className="k">{v.label}</span>
                <span className="v mono" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {v.value ?? "—"}
                  <span className={`chip ${tone}`} style={{ height: 18, fontSize: 10 }}>
                    {label}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {treeSummary ? (
        <div>
          <div className="section-label" style={{ marginBottom: 6 }}>
            <span>Resumen</span>
            <Info size={12} aria-hidden="true" style={{ color: "var(--muted-2)" }} />
          </div>
          <p style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.5, margin: 0 }}>
            {treeSummary}
          </p>
        </div>
      ) : null}
    </>
  );
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("es-AR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return "";
  }
}
