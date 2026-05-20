"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock3,
  Loader2,
  Play
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  indexingRunTone,
  indexingStageLabel,
  type IndexingEventRow,
  type IndexingRunStatus,
  type IndexingRunRow,
  type IndexingStage
} from "@/lib/documents";
import { compactId, formatDateTime } from "@/lib/session";
import { INDEXING_VERSION_COLUMNS } from "@/lib/system-versions";
import { createClient } from "@/lib/supabase/client";

type IndexingTimelineProps = {
  documentId: string;
  initialEvents: IndexingEventRow[];
  initialRun: IndexingRunRow | null;
};

const PIPELINE: IndexingStage[] = [
  "queued",
  "extracting",
  "structuring",
  "verifying_tree",
  "refining_tree",
  "summarizing",
  "embedding",
  "persisting",
  "indexed"
];

type StageState = "done" | "active" | "pending" | "error";

function railRows(run: IndexingRunRow | null): { stage: IndexingStage; state: StageState }[] {
  const completed = run?.status === "completed";
  const failed = run?.status === "failed" || run?.status === "canceled";
  const currentIndex = run ? PIPELINE.indexOf(run.stage as IndexingStage) : -1;

  return PIPELINE.map((stage, index) => {
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

function stageGlyph(state: StageState) {
  if (state === "done") {
    return <CheckCircle2 aria-hidden="true" size={14} />;
  }

  if (state === "active") {
    return <Loader2 aria-hidden="true" className="spin" size={14} />;
  }

  if (state === "error") {
    return <AlertTriangle aria-hidden="true" size={14} />;
  }

  return <Circle aria-hidden="true" size={14} />;
}

function eventIcon(event: IndexingEventRow) {
  if (event.severity === "error") {
    return <AlertTriangle aria-hidden="true" size={16} />;
  }

  if (event.event_type.endsWith(".completed")) {
    return <CheckCircle2 aria-hidden="true" size={16} />;
  }

  return <Circle aria-hidden="true" size={16} />;
}

function sortEvents(events: IndexingEventRow[]) {
  return [...events].sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  );
}

export function IndexingTimeline({
  documentId,
  initialEvents,
  initialRun
}: IndexingTimelineProps) {
  const [events, setEvents] = useState(() => sortEvents(initialEvents));
  const [run, setRun] = useState<IndexingRunRow | null>(initialRun);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const sortedEvents = useMemo(() => sortEvents(events), [events]);
  const stages = useMemo(() => railRows(run), [run]);
  const canRequest = !run || run.status === "completed" || run.status === "failed" || run.status === "canceled";

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`document-indexing:${documentId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `document_id=eq.${documentId}`,
          schema: "public",
          table: "indexing_runs"
        },
        (payload) => {
          const nextRun = payload.new as IndexingRunRow;

          if (!nextRun?.id) {
            return;
          }

          setRun((currentRun) => {
            if (!currentRun) {
              return nextRun;
            }

            return new Date(nextRun.created_at) >= new Date(currentRun.created_at)
              ? nextRun
              : currentRun;
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          filter: `document_id=eq.${documentId}`,
          schema: "public",
          table: "indexing_events"
        },
        (payload) => {
          const nextEvent = payload.new as IndexingEventRow;

          if (!nextEvent?.id) {
            return;
          }

          setEvents((currentEvents) => {
            if (currentEvents.some((event) => event.id === nextEvent.id)) {
              return currentEvents;
            }

            return sortEvents([...currentEvents, nextEvent]).slice(-80);
          });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [documentId]);

  async function requestIndexing() {
    setRequestError(null);
    setRequesting(true);

    const response = await fetch(`/api/documents/${documentId}/indexing/request`, {
      body: JSON.stringify({ source: "document_detail" }),
      headers: {
        "Content-Type": "application/json"
      },
      method: "POST"
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

    setRequesting(false);

    if (!response.ok) {
      setRequestError(payload?.error ?? "No se pudo pedir la indexación.");
      return;
    }

    const runRow = payload?.run;

    if (runRow?.run_id) {
      setRun((currentRun) => ({
        attempt: currentRun?.attempt ?? 1,
        completed_at: currentRun?.completed_at ?? null,
        compute_job_id: currentRun?.compute_job_id ?? null,
        created_at: currentRun?.created_at ?? new Date().toISOString(),
        document_id: runRow.document_id,
        embedding_pipeline_version:
          currentRun?.embedding_pipeline_version ??
          INDEXING_VERSION_COLUMNS.embedding_pipeline_version,
        error_message: null,
        extraction_pipeline_version:
          currentRun?.extraction_pipeline_version ??
          INDEXING_VERSION_COLUMNS.extraction_pipeline_version,
        failed_at: null,
        id: runRow.run_id,
        inngest_run_id: currentRun?.inngest_run_id ?? null,
        indexing_pipeline_version:
          currentRun?.indexing_pipeline_version ??
          INDEXING_VERSION_COLUMNS.indexing_pipeline_version,
        progress: runRow.progress,
        stage: runRow.stage,
        started_at: currentRun?.started_at ?? null,
        status: runRow.status,
        tree_indexer_version:
          currentRun?.tree_indexer_version ?? INDEXING_VERSION_COLUMNS.tree_indexer_version
      }));
    }
  }

  return (
    <div className="timeline-panel">
      <div className="timeline-summary">
        <div>
          <div className="timeline-kicker">SDA Tree Index</div>
          <h3>{run ? indexingStageLabel(run.stage) : "Sin corrida todavía"}</h3>
          <p>
            {run
              ? `${run.compute_job_id ? `Job ${compactId(run.compute_job_id)} · ` : ""}Intento ${run.attempt} · ${run.progress}% completado`
              : "Creá una corrida para dejar el documento en cola de indexación."}
          </p>
        </div>
        {run ? <Badge tone={indexingRunTone(run.status)}>{run.status}</Badge> : null}
      </div>

      {run ? (
        <div className="progress-track" aria-label={`Progreso ${run.progress}%`}>
          <div className="progress-bar" style={{ width: `${run.progress}%` }} />
        </div>
      ) : null}

      <div className="stage-rail" aria-hidden="true">
        {stages.map(({ stage, state }) => (
          <div className={`stage-row is-${state}`} key={stage}>
            <span className="stage-ico">{stageGlyph(state)}</span>
            <span className="stage-name">{indexingStageLabel(stage)}</span>
            <span className="stage-tag">
              {state === "done" ? "ok" : state === "active" ? "···" : state === "error" ? "err" : ""}
            </span>
          </div>
        ))}
      </div>

      <div className="card-actions">
        <Button
          disabled={!canRequest || requesting}
          leftIcon={
            requesting ? (
              <Loader2 aria-hidden="true" className="spin" size={16} />
            ) : (
              <Play aria-hidden="true" size={16} />
            )
          }
          onClick={requestIndexing}
          variant="primary"
        >
          {run?.status === "completed" ? "Reindexar" : "Poner en cola"}
        </Button>
        {run?.created_at ? (
          <span className="inline-icon muted">
            <Clock3 aria-hidden="true" size={14} />
            {formatDateTime(run.created_at)}
          </span>
        ) : null}
      </div>

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

      {sortedEvents.length === 0 ? (
        <div className="empty-state">
          <Clock3 aria-hidden="true" size={22} />
          <div>
            <strong>Sin eventos todavía.</strong>
            <p>Cuando Inngest y el compute gateway trabajen, vas a ver cada paso acá.</p>
          </div>
        </div>
      ) : (
        <ol className="timeline-list">
          {sortedEvents.map((event) => (
            <li className={`timeline-item timeline-${event.severity}`} key={event.id}>
              <span className="timeline-icon">{eventIcon(event)}</span>
              <span className="timeline-content">
                <strong>{event.message}</strong>
                <span>
                  {indexingStageLabel(event.stage)}
                  {typeof event.progress === "number" ? ` · ${event.progress}%` : ""} ·{" "}
                  {formatDateTime(event.created_at)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
