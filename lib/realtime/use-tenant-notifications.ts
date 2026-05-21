"use client";

import { useEffect, useState } from "react";

import {
  normalizeRealtimeStatus,
  type RealtimeSubscriptionStatus
} from "@/lib/realtime/status";
import { createClient } from "@/lib/supabase/client";

export type TenantRealtimeNotification = {
  event: string;
  id: string;
  payload: Record<string, unknown>;
  received_at: string;
};

type UseTenantNotificationsInput = {
  limit?: number;
  tenantId: string;
};

export function useTenantNotifications({ limit = 20, tenantId }: UseTenantNotificationsInput) {
  const [notificationState, setNotificationState] = useState<{
    notifications: TenantRealtimeNotification[];
    tenantId: string;
  }>(() => ({
    notifications: [],
    tenantId
  }));
  const [subscription, setSubscription] = useState<{
    error: string | null;
    status: RealtimeSubscriptionStatus;
    tenantId: string;
  }>(() => ({
    error: null,
    status: "connecting",
    tenantId
  }));
  const notifications = notificationState.tenantId === tenantId ? notificationState.notifications : [];
  const status = subscription.tenantId === tenantId ? subscription.status : "connecting";
  const error = subscription.tenantId === tenantId ? subscription.error : null;

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`tenant:${tenantId}:notifications`, {
        config: {
          broadcast: { self: false },
          private: true
        }
      })
      .on("broadcast", { event: "document_changed" }, (message) => {
        setNotificationState((currentState) => {
          const currentNotifications =
            currentState.tenantId === tenantId ? currentState.notifications : [];

          return {
            notifications: [
              {
                event: "document_changed",
                id: `${Date.now()}:${currentNotifications.length}`,
                payload: (message.payload ?? {}) as Record<string, unknown>,
                received_at: new Date().toISOString()
              },
              ...currentNotifications
            ].slice(0, limit),
            tenantId
          };
        });
      })
      .subscribe((nextStatus, nextError) => {
        setSubscription({
          error: nextError?.message ?? null,
          status: normalizeRealtimeStatus(nextStatus),
          tenantId
        });
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [limit, tenantId]);

  return {
    notificationError: error,
    notificationStatus: status,
    notifications
  };
}
