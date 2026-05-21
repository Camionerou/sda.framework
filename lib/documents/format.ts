import type { DocumentStatus, IndexingRunStatus, IndexingStage } from "@/lib/documents/types";

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

  if (status === "failed" || status === "archived") {
    return "danger" as const;
  }

  return "warning" as const;
}

export function documentStatusLabel(status: DocumentStatus) {
  const labels: Record<DocumentStatus, string> = {
    archived: "Archivado",
    embedding: "Embeddings",
    failed: "Falló",
    indexed: "Indexado",
    parsing: "Extrayendo",
    queued: "En cola",
    structuring: "Armando árbol",
    uploaded: "Subido",
    uploading: "Subiendo"
  };

  return labels[status];
}

export function indexingStageLabel(stage: IndexingStage | string) {
  const labels: Record<IndexingStage, string> = {
    canceled: "Cancelado",
    embedding: "Generando embeddings",
    extracting: "Extrayendo documento",
    failed: "Falló",
    indexed: "Indexado",
    persisting: "Guardando índice",
    queued: "En cola",
    refining_tree: "Refinando árbol",
    structuring: "Armando árbol",
    summarizing: "Generando summaries",
    verifying_tree: "Verificando árbol"
  };

  return labels[stage as IndexingStage] ?? stage;
}

export function indexingRunTone(status: IndexingRunStatus) {
  if (status === "completed") {
    return "success" as const;
  }

  if (status === "failed" || status === "canceled") {
    return "danger" as const;
  }

  return "warning" as const;
}
