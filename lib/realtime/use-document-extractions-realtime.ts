"use client";

import { useEffect, useMemo, useState } from "react";

import {
  type DocumentExtractionArtifactRow,
  type DocumentExtractionRow
} from "@/lib/documents";
import {
  normalizeRealtimeStatus,
  type RealtimeSubscriptionStatus
} from "@/lib/realtime/status";
import { createClient } from "@/lib/supabase/client";

type UseDocumentExtractionsRealtimeInput = {
  artifactLimit?: number;
  documentId: string;
  extractionLimit?: number;
  initialArtifacts: DocumentExtractionArtifactRow[];
  initialExtractions: DocumentExtractionRow[];
};

function sortExtractions(rows: DocumentExtractionRow[]) {
  return [...rows].sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );
}

function sortArtifacts(rows: DocumentExtractionArtifactRow[]) {
  return [...rows].sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );
}

export function useDocumentExtractionsRealtime({
  artifactLimit = 24,
  documentId,
  extractionLimit = 5,
  initialArtifacts,
  initialExtractions
}: UseDocumentExtractionsRealtimeInput) {
  const baseArtifacts = useMemo(
    () => sortArtifacts(initialArtifacts).slice(0, artifactLimit),
    [artifactLimit, initialArtifacts]
  );
  const baseExtractions = useMemo(
    () => sortExtractions(initialExtractions).slice(0, extractionLimit),
    [extractionLimit, initialExtractions]
  );
  const [liveArtifacts, setLiveArtifacts] = useState<{
    documentId: string;
    rows: Map<string, DocumentExtractionArtifactRow | null>;
  }>(() => ({
    documentId,
    rows: new Map<string, DocumentExtractionArtifactRow | null>()
  }));
  const [liveExtractions, setLiveExtractions] = useState<{
    documentId: string;
    rows: Map<string, DocumentExtractionRow | null>;
  }>(() => ({
    documentId,
    rows: new Map<string, DocumentExtractionRow | null>()
  }));
  const [subscription, setSubscription] = useState<{
    documentId: string;
    error: string | null;
    status: RealtimeSubscriptionStatus;
  }>(() => ({
    documentId,
    error: null,
    status: "connecting"
  }));

  const artifacts = useMemo(() => {
    const byId = new Map<string, DocumentExtractionArtifactRow>();

    for (const artifact of baseArtifacts) {
      if (artifact.document_id === documentId) {
        byId.set(artifact.id, artifact);
      }
    }

    if (liveArtifacts.documentId === documentId) {
      for (const [artifactId, artifact] of liveArtifacts.rows) {
        if (artifact) {
          byId.set(artifactId, artifact);
        } else {
          byId.delete(artifactId);
        }
      }
    }

    return sortArtifacts([...byId.values()]).slice(0, artifactLimit);
  }, [artifactLimit, baseArtifacts, documentId, liveArtifacts]);

  const extractions = useMemo(() => {
    const byId = new Map<string, DocumentExtractionRow>();

    for (const extraction of baseExtractions) {
      if (extraction.document_id === documentId) {
        byId.set(extraction.id, extraction);
      }
    }

    if (liveExtractions.documentId === documentId) {
      for (const [extractionId, extraction] of liveExtractions.rows) {
        if (extraction) {
          byId.set(extractionId, extraction);
        } else {
          byId.delete(extractionId);
        }
      }
    }

    return sortExtractions([...byId.values()]).slice(0, extractionLimit);
  }, [baseExtractions, documentId, extractionLimit, liveExtractions]);

  const status = subscription.documentId === documentId ? subscription.status : "connecting";
  const error = subscription.documentId === documentId ? subscription.error : null;

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`document:${documentId}:postgres-extractions`)
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `document_id=eq.${documentId}`,
          schema: "public",
          table: "document_extractions"
        },
        (payload) => {
          const nextExtraction = payload.new as DocumentExtractionRow;

          if (!nextExtraction?.id) {
            return;
          }

          setLiveExtractions((currentState) => {
            const rows =
              currentState.documentId === documentId
                ? new Map(currentState.rows)
                : new Map<string, DocumentExtractionRow | null>();
            rows.set(nextExtraction.id, nextExtraction);
            return { documentId, rows };
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          filter: `document_id=eq.${documentId}`,
          schema: "public",
          table: "document_extraction_artifacts"
        },
        (payload) => {
          const nextArtifact = payload.new as DocumentExtractionArtifactRow;

          if (!nextArtifact?.id) {
            return;
          }

          setLiveArtifacts((currentState) => {
            const rows =
              currentState.documentId === documentId
                ? new Map(currentState.rows)
                : new Map<string, DocumentExtractionArtifactRow | null>();
            rows.set(nextArtifact.id, nextArtifact);
            return { documentId, rows };
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
  }, [documentId]);

  return {
    artifacts,
    extractions,
    realtimeError: error,
    realtimeStatus: status
  };
}
