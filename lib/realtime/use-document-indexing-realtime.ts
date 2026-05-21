"use client";

import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import {
  type IndexingEventRow,
  type IndexingRunRow,
  type IndexingRunStatus
} from "@/lib/documents";
import {
  normalizeRealtimeStatus,
  type RealtimeSubscriptionStatus
} from "@/lib/realtime/status";

type UseDocumentIndexingRealtimeInput = {
  documentId: string;
  eventLimit?: number;
  initialEvents: IndexingEventRow[];
  initialRun: IndexingRunRow | null;
  onTerminalRun?: (run: IndexingRunRow) => void;
};

const TERMINAL_RUN_STATUSES: IndexingRunStatus[] = ["canceled", "completed", "failed"];

function sortEvents(events: IndexingEventRow[]) {
  return [...events].sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  );
}

function isTerminalRun(run: IndexingRunRow) {
  return TERMINAL_RUN_STATUSES.includes(run.status);
}

function latestRunForDocument(
  documentId: string,
  initialRun: IndexingRunRow | null,
  liveRun: IndexingRunRow | null
) {
  const initial = initialRun?.document_id === documentId ? initialRun : null;
  const live = liveRun?.document_id === documentId ? liveRun : null;

  if (!initial || !live) {
    return live ?? initial;
  }

  if (initial.id === live.id) {
    return live;
  }

  return new Date(live.created_at) >= new Date(initial.created_at) ? live : initial;
}

export function useDocumentIndexingRealtime({
  documentId,
  eventLimit = 120,
  initialEvents,
  initialRun,
  onTerminalRun
}: UseDocumentIndexingRealtimeInput) {
  const baseEvents = useMemo(() => sortEvents(initialEvents).slice(-eventLimit), [eventLimit, initialEvents]);
  const [liveEvents, setLiveEvents] = useState<IndexingEventRow[]>([]);
  const [liveRun, setLiveRun] = useState<IndexingRunRow | null>(null);
  const [subscription, setSubscription] = useState<{
    documentId: string;
    error: string | null;
    status: RealtimeSubscriptionStatus;
  }>(() => ({
    documentId,
    error: null,
    status: "connecting"
  }));
  const terminalNotified = useRef<Set<string>>(new Set());

  const events = useMemo(() => {
    const byId = new Map<string, IndexingEventRow>();

    for (const event of [...baseEvents, ...liveEvents]) {
      if (event.document_id === documentId) {
        byId.set(event.id, event);
      }
    }

    return sortEvents([...byId.values()]).slice(-eventLimit);
  }, [baseEvents, documentId, eventLimit, liveEvents]);

  const run = useMemo(
    () => latestRunForDocument(documentId, initialRun, liveRun),
    [documentId, initialRun, liveRun]
  );

  const setRun = useCallback(
    (nextRun: SetStateAction<IndexingRunRow | null>) => {
      setLiveRun((currentLiveRun) => {
        const currentRun = latestRunForDocument(documentId, initialRun, currentLiveRun);
        return typeof nextRun === "function"
          ? (nextRun as (currentRun: IndexingRunRow | null) => IndexingRunRow | null)(currentRun)
          : nextRun;
      });
    },
    [documentId, initialRun]
  );

  const status = subscription.documentId === documentId ? subscription.status : "connecting";
  const error = subscription.documentId === documentId ? subscription.error : null;

  useEffect(() => {
    const supabase = createClient();

    const maybeNotifyTerminal = (nextRun: IndexingRunRow) => {
      if (!isTerminalRun(nextRun)) {
        return;
      }

      const key = `${nextRun.id}:${nextRun.status}`;
      if (terminalNotified.current.has(key)) {
        return;
      }

      terminalNotified.current.add(key);
      onTerminalRun?.(nextRun);
    };

    const channel = supabase
      .channel(`document:${documentId}:postgres-indexing`)
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
          maybeNotifyTerminal(nextRun);
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

          setLiveEvents((currentEvents) => {
            if (currentEvents.some((event) => event.id === nextEvent.id)) {
              return currentEvents;
            }

            const currentDocumentEvents = currentEvents.filter((event) => event.document_id === documentId);
            return sortEvents([...currentDocumentEvents, nextEvent]).slice(-eventLimit);
          });
        }
      )
      .subscribe((nextStatus, nextError) => {
        setSubscription({
          documentId,
          error: nextError?.message ?? null,
          status: normalizeRealtimeStatus(nextStatus)
        });
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [documentId, eventLimit, onTerminalRun, setRun]);

  return {
    events,
    realtimeError: error,
    realtimeStatus: status,
    run,
    setRun
  };
}
