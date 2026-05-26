import {
  FileText,
  Upload,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  GitBranch,
  ArrowRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// --- Placeholder data ---
const recentDocuments = [
  {
    id: "1",
    name: "Arquitectura del sistema v2.pdf",
    status: "ready",
    pages: 24,
    nodes: 87,
    updatedAt: "Hace 2 horas",
  },
  {
    id: "2",
    name: "Manual de usuario — Módulo ingestión.md",
    status: "summarizing",
    pages: 12,
    nodes: null,
    updatedAt: "Hace 15 min",
  },
  {
    id: "3",
    name: "Especificaciones API REST 2026.pdf",
    status: "pending",
    pages: 48,
    nodes: null,
    updatedAt: "Hace 1 hora",
  },
  {
    id: "4",
    name: "Roadmap Q2-Q3 2026.md",
    status: "ready",
    pages: 6,
    nodes: 22,
    updatedAt: "Ayer",
  },
  {
    id: "5",
    name: "Reporte de errores — Sprint 14.pdf",
    status: "failed",
    pages: 3,
    nodes: null,
    updatedAt: "Hace 3 días",
  },
];

const statusConfig = {
  ready: {
    label: "Listo",
    icon: CheckCircle2,
    className: "text-emerald-600 bg-emerald-50 border-emerald-200",
  },
  summarizing: {
    label: "Procesando",
    icon: Loader2,
    className: "text-amber-600 bg-amber-50 border-amber-200",
  },
  pending: {
    label: "En cola",
    icon: Clock,
    className: "text-muted-foreground bg-muted border-border",
  },
  failed: {
    label: "Error",
    icon: AlertCircle,
    className: "text-destructive bg-destructive/5 border-destructive/20",
  },
};

function StatusBadge({ status }: { status: keyof typeof statusConfig }) {
  const config = statusConfig[status];
  const Icon = config.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium border",
        config.className
      )}
    >
      <Icon className={cn("size-3", status === "summarizing" && "animate-spin")} />
      {config.label}
    </span>
  );
}

function QuickStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-card border border-border rounded-lg px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground tracking-tight">{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

export function HomeView() {
  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Home</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Resumen de tu actividad de ingestión e indexación
          </p>
        </div>
        <Button size="sm" className="gap-2">
          <Upload className="size-3.5" />
          Subir documento
        </Button>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <QuickStat label="Documentos totales" value="5" />
        <QuickStat label="Indexados" value="2" sub="Listos para consultar" />
        <QuickStat label="Nodos generados" value="109" sub="En el grafo de conocimiento" />
        <QuickStat label="Procesando ahora" value="1" sub="Tiempo estimado: 3 min" />
      </div>

      {/* Recent documents */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Documentos recientes</h2>
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground h-auto py-1">
            Ver todos
            <ArrowRight className="size-3" />
          </Button>
        </div>

        <div className="flex flex-col border border-border rounded-lg overflow-hidden">
          {recentDocuments.map((doc, i) => (
            <div
              key={doc.id}
              className={cn(
                "flex items-center gap-4 px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer",
                i !== recentDocuments.length - 1 && "border-b border-border"
              )}
            >
              {/* Icon */}
              <div className="flex size-8 items-center justify-center rounded-md bg-muted shrink-0">
                <FileText className="size-4 text-muted-foreground" />
              </div>

              {/* Name + meta */}
              <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                <span className="text-sm font-medium text-foreground truncate">
                  {doc.name}
                </span>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{doc.pages} páginas</span>
                  {doc.nodes !== null && (
                    <>
                      <span>·</span>
                      <span className="flex items-center gap-1">
                        <GitBranch className="size-3" />
                        {doc.nodes} nodos
                      </span>
                    </>
                  )}
                  <span>·</span>
                  <span>{doc.updatedAt}</span>
                </div>
              </div>

              {/* Status */}
              <StatusBadge status={doc.status as keyof typeof statusConfig} />
            </div>
          ))}
        </div>
      </div>

      {/* Empty state placeholder for graph */}
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Grafo de conocimiento</h2>
        <div className="flex flex-col items-center justify-center gap-3 border border-dashed border-border rounded-lg py-12 text-center">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <GitBranch className="size-5 text-muted-foreground" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">Vista de grafo disponible pronto</span>
            <span className="text-xs text-muted-foreground max-w-xs">
              Una vez que tus documentos sean indexados, podrás explorar el árbol de nodos jerárquico aquí.
            </span>
          </div>
          <Button variant="outline" size="sm">
            Ir al grafo
          </Button>
        </div>
      </div>

      {/* Loading skeleton example */}
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Actividad reciente</h2>
        <div className="flex flex-col gap-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border border-border rounded-lg">
              <Skeleton className="size-8 rounded-md shrink-0" />
              <div className="flex flex-col gap-1.5 flex-1">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-5 w-16 rounded-md" />
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground text-center">
          El feed de actividad estará disponible cuando se conecte con Supabase.
        </p>
      </div>
    </div>
  );
}
