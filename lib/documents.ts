export type DocumentStatus =
  | "uploading"
  | "uploaded"
  | "queued"
  | "indexing"
  | "indexed"
  | "failed"
  | "deleted";

export type DocumentRow = {
  byte_size: number | null;
  created_at: string;
  filename: string;
  id: string;
  indexed_at: string | null;
  mime_type: string;
  r2_bucket: string;
  r2_key: string;
  status: DocumentStatus;
  status_reason: string | null;
  title: string | null;
  uploaded_at: string | null;
};

export function formatBytes(value: number | null) {
  if (!value) {
    return "Sin dato";
  }

  return new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: 1,
    style: "unit",
    unit: value >= 1024 * 1024 ? "megabyte" : "kilobyte",
    unitDisplay: "short"
  }).format(value >= 1024 * 1024 ? value / 1024 / 1024 : value / 1024);
}

export function documentStatusTone(status: DocumentStatus) {
  if (status === "uploaded" || status === "indexed") {
    return "success" as const;
  }

  if (status === "failed" || status === "deleted") {
    return "danger" as const;
  }

  return "warning" as const;
}

export function documentStatusLabel(status: DocumentStatus) {
  const labels: Record<DocumentStatus, string> = {
    deleted: "Eliminado",
    failed: "Falló",
    indexed: "Indexado",
    indexing: "Indexando",
    queued: "En cola",
    uploaded: "Subido",
    uploading: "Subiendo"
  };

  return labels[status];
}
