import {
  FileText,
  Upload,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  GitBranch,
  ArrowUpRight,
  FilePlus2,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const recentDocuments = [
  {
    id: "1",
    name: "Arquitectura del sistema v2.pdf",
    type: "pdf",
    status: "ready" as const,
    pages: 24,
    nodes: 87,
    updatedAt: "Hace 2 horas",
  },
  {
    id: "2",
    name: "Manual de usuario — Módulo ingestión.md",
    type: "md",
    status: "summarizing" as const,
    pages: 12,
    nodes: null,
    updatedAt: "Hace 15 min",
  },
  {
    id: "3",
    name: "Especificaciones API REST 2026.pdf",
    type: "pdf",
    status: "pending" as const,
    pages: 48,
    nodes: null,
    updatedAt: "Hace 1 hora",
  },
  {
    id: "4",
    name: "Roadmap Q2-Q3 2026.md",
    type: "md",
    status: "ready" as const,
    pages: 6,
    nodes: 22,
    updatedAt: "Ayer",
  },
  {
    id: "5",
    name: "Reporte de errores — Sprint 14.pdf",
    type: "pdf",
    status: "failed" as const,
    pages: 3,
    nodes: null,
    updatedAt: "Hace 3 días",
  },
];

const statusConfig = {
  ready: {
    label: "Listo",
    icon: CheckCircle2,
    dot: "bg-emerald-500",
    text: "text-emerald-600",
  },
  summarizing: {
    label: "Procesando",
    icon: Loader2,
    dot: "bg-amber-400",
    text: "text-amber-600",
  },
  pending: {
    label: "En cola",
    icon: Clock,
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
  failed: {
    label: "Error",
    icon: AlertCircle,
    dot: "bg-destructive",
    text: "text-destructive",
  },
};

function DocRow({ doc }: { doc: (typeof recentDocuments)[0] }) {
  const s = statusConfig[doc.status];
  const Icon = s.icon;
  const isSpinning = doc.status === "summarizing";

  return (
    <div className="group flex items-center gap-4 px-4 py-3 rounded-xl hover:bg-muted/60 transition-colors cursor-pointer -mx-2">
      {/* File icon */}
      <div className="flex size-9 items-center justify-center rounded-lg bg-muted shrink-0 group-hover:bg-background transition-colors">
        <FileText className="size-4 text-muted-foreground" />
      </div>

      {/* Name + meta */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate leading-snug">
          {doc.name}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground">{doc.pages} pág.</span>
          {doc.nodes !== null && (
            <>
              <span className="text-muted-foreground/40 text-xs">·</span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <GitBranch className="size-3" />
                {doc.nodes} nodos
              </span>
            </>
          )}
          <span className="text-muted-foreground/40 text-xs">·</span>
          <span className="text-xs text-muted-foreground">{doc.updatedAt}</span>
        </div>
      </div>

      {/* Status */}
      <div className={cn("flex items-center gap-1.5 shrink-0", s.text)}>
        <Icon className={cn("size-3.5", isSpinning && "animate-spin")} />
        <span className="text-xs font-medium">{s.label}</span>
      </div>
    </div>
  );
}

const quickActions = [
  { label: "Subir documento", icon: FilePlus2 },
  { label: "Buscar en docs", icon: Search },
  { label: "Ver grafo", icon: GitBranch },
  { label: "Resumir con IA", icon: Sparkles },
];

export function HomeView() {
  return (
    <div className="flex flex-col min-h-full">
      <div className="flex flex-col gap-10 max-w-3xl mx-auto w-full px-8 py-12">

        {/* Welcome */}
        <div className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground text-balance">
            Bienvenido a SDA Framework
          </h1>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl">
            Ingesta, indexa y consulta tus documentos con IA. Sube un archivo para empezar o explorá los documentos ya procesados.
          </p>

          {/* Quick actions */}
          <div className="flex flex-wrap gap-2 mt-2">
            {quickActions.map(({ label, icon: Icon }) => (
              <button
                key={label}
                className="flex items-center gap-2 px-4 py-2 rounded-full border border-border bg-card hover:bg-muted transition-colors text-sm text-foreground font-medium"
              >
                <Icon className="size-3.5 text-muted-foreground" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Recent documents */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Documentos recientes
            </h2>
            <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
              Ver todos
              <ArrowUpRight className="size-3" />
            </button>
          </div>

          <div className="flex flex-col">
            {recentDocuments.map((doc) => (
              <DocRow key={doc.id} doc={doc} />
            ))}
          </div>
        </div>

        {/* Knowledge graph placeholder */}
        <div className="flex flex-col gap-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Grafo de conocimiento
          </h2>
          <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-muted/30 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <GitBranch className="size-5 text-muted-foreground" />
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-foreground">
                Vista de grafo disponible pronto
              </p>
              <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
                Una vez que tus documentos sean indexados, podrás explorar el árbol de nodos jerárquico aquí.
              </p>
            </div>
            <Button variant="outline" size="sm" className="rounded-full px-5">
              Ir al grafo
            </Button>
          </div>
        </div>

        {/* Upload CTA */}
        <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-6 py-5">
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-medium text-foreground">Subir nuevo documento</p>
            <p className="text-xs text-muted-foreground">PDF, Markdown o texto plano. Máx. 50 MB.</p>
          </div>
          <Button size="sm" className="gap-2 rounded-full px-5">
            <Upload className="size-3.5" />
            Subir
          </Button>
        </div>

      </div>
    </div>
  );
}
