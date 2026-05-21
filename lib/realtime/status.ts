export type RealtimeSubscriptionStatus =
  | "closed"
  | "connecting"
  | "error"
  | "idle"
  | "subscribed"
  | "timed_out";

export function normalizeRealtimeStatus(status: string): RealtimeSubscriptionStatus {
  if (status === "SUBSCRIBED") {
    return "subscribed";
  }

  if (status === "CHANNEL_ERROR") {
    return "error";
  }

  if (status === "TIMED_OUT") {
    return "timed_out";
  }

  if (status === "CLOSED") {
    return "closed";
  }

  return "connecting";
}

export function realtimeStatusLabel(status: RealtimeSubscriptionStatus) {
  if (status === "subscribed") {
    return "Live";
  }

  if (status === "connecting") {
    return "Conectando";
  }

  if (status === "timed_out") {
    return "Timeout";
  }

  if (status === "error") {
    return "Error";
  }

  if (status === "closed") {
    return "Cerrado";
  }

  return "Idle";
}

export function realtimeStatusTone(status: RealtimeSubscriptionStatus) {
  if (status === "subscribed") {
    return "success" as const;
  }

  if (status === "connecting" || status === "idle") {
    return "warning" as const;
  }

  return "danger" as const;
}
