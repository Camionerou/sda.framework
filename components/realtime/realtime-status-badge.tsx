import { Badge } from "@/components/ui/badge";
import {
  realtimeStatusLabel,
  realtimeStatusTone,
  type RealtimeSubscriptionStatus
} from "@/lib/realtime/status";

type RealtimeStatusBadgeProps = {
  label?: string;
  status: RealtimeSubscriptionStatus;
};

export function RealtimeStatusBadge({ label, status }: RealtimeStatusBadgeProps) {
  return (
    <Badge tone={realtimeStatusTone(status)} title={label ? `${label}: ${realtimeStatusLabel(status)}` : undefined}>
      {label ? `${label} ` : null}
      {realtimeStatusLabel(status)}
    </Badge>
  );
}
