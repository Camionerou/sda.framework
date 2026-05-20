import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type BadgeTone = "neutral" | "success" | "warning" | "danger";

export function Badge({
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "badge",
        tone === "success" && "badge-success",
        tone === "warning" && "badge-warning",
        tone === "danger" && "badge-danger",
        className
      )}
      {...props}
    />
  );
}
