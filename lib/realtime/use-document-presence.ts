"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  normalizeRealtimeStatus,
  type RealtimeSubscriptionStatus
} from "@/lib/realtime/status";
import { createClient } from "@/lib/supabase/client";

export type DocumentPresenceViewer = {
  key: string;
  label: string;
  online_at: string;
  page: number;
  updated_at: string;
  user_id: string;
};

type UseDocumentPresenceInput = {
  currentPage: number;
  documentId: string;
  label: string;
  userId: string;
};

type TrackableChannel = {
  presenceState: () => Record<string, Array<Omit<DocumentPresenceViewer, "key">>>;
  track: (payload: Omit<DocumentPresenceViewer, "key">) => Promise<unknown>;
};

function payload(input: UseDocumentPresenceInput): Omit<DocumentPresenceViewer, "key"> {
  const now = new Date().toISOString();

  return {
    label: input.label,
    online_at: now,
    page: input.currentPage,
    updated_at: now,
    user_id: input.userId
  };
}

function uniqueViewers(state: Record<string, Array<Omit<DocumentPresenceViewer, "key">>>) {
  const byUser = new Map<string, DocumentPresenceViewer>();

  for (const [key, presences] of Object.entries(state)) {
    for (const presence of presences) {
      const current = byUser.get(presence.user_id);
      if (!current || new Date(presence.updated_at) > new Date(current.updated_at)) {
        byUser.set(presence.user_id, { ...presence, key });
      }
    }
  }

  return [...byUser.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function useDocumentPresence(input: UseDocumentPresenceInput) {
  const { currentPage, documentId, label, userId } = input;
  const instanceId = useId();
  const channelRef = useRef<TrackableChannel | null>(null);
  const latestInputRef = useRef(input);
  const subscribedRef = useRef(false);

  const presenceKey = `${userId}:${instanceId}`;
  const channelKey = `${documentId}:${presenceKey}`;
  const [viewerState, setViewerState] = useState<{
    key: string;
    viewers: DocumentPresenceViewer[];
  }>(() => ({
    key: channelKey,
    viewers: []
  }));
  const [subscription, setSubscription] = useState<{
    error: string | null;
    key: string;
    status: RealtimeSubscriptionStatus;
  }>(() => ({
    error: null,
    key: channelKey,
    status: "connecting"
  }));
  const viewers = viewerState.key === channelKey ? viewerState.viewers : [];
  const status = subscription.key === channelKey ? subscription.status : "connecting";
  const error = subscription.key === channelKey ? subscription.error : null;

  useEffect(() => {
    latestInputRef.current = { currentPage, documentId, label, userId };
  }, [currentPage, documentId, label, userId]);

  useEffect(() => {
    const supabase = createClient();
    subscribedRef.current = false;

    const channel = supabase
      .channel(`document:${documentId}:presence`, {
        config: {
          presence: { key: presenceKey },
          private: true
        }
      })
      .on("presence", { event: "sync" }, () => {
        setViewerState({
          key: channelKey,
          viewers: uniqueViewers(channel.presenceState() as Record<string, Array<Omit<DocumentPresenceViewer, "key">>>)
        });
      })
      .subscribe((nextStatus, nextError) => {
        setSubscription({
          error: nextError?.message ?? null,
          key: channelKey,
          status: normalizeRealtimeStatus(nextStatus)
        });

        if (nextStatus === "SUBSCRIBED") {
          subscribedRef.current = true;
          void channel.track(payload(latestInputRef.current));
        }
      });

    channelRef.current = channel as TrackableChannel;

    return () => {
      subscribedRef.current = false;
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [channelKey, documentId, presenceKey]);

  useEffect(() => {
    if (!subscribedRef.current || !channelRef.current) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void channelRef.current?.track(payload(latestInputRef.current));
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [currentPage, documentId, label, userId]);

  return {
    presenceError: error,
    presenceStatus: status,
    viewers
  };
}
