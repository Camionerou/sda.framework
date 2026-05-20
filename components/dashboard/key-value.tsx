import type { ReactNode } from "react";

export function KeyValue({ label, children }: { children: ReactNode; label: string }) {
  return (
    <div className="key-value">
      <div className="key">{label}</div>
      <div className="value">{children}</div>
    </div>
  );
}
